"""PR tooling over the `gh` CLI — subprocess only, never direct HTTP.

  list_prs(root)              — open PRs via `gh pr list --json ...`
  pr_impact(g, number, root)  — a PR's changed files -> affected() closure
  worktree_map(root)          — `git worktree list` paths (if git available)
  triage_prs(g, root)         — structural ranking: blast radius + file overlap
  conflict_hints(g, root)     — PRs whose affected-file sets overlap (no LLM)

`gh` handles auth, the API endpoint, and enterprise hosts; this module only
parses its `--json` output. A missing or unauthenticated `gh` degrades to a
one-line, caller-actionable ``{"error": ...}`` — never a crash.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

from . import algorithms as alg_mod
from .graph import SymbolGraph

GH_HELP = "install the GitHub CLI (https://cli.github.com) and run `gh auth login`"


def _run_gh(args: list[str], root: str) -> tuple[object, str | None]:
    """Run one `gh` command in *root*; -> (parsed_json, None) or (None, error)."""
    if shutil.which("gh") is None:
        return None, f"gh CLI not found — {GH_HELP}"
    try:
        proc = subprocess.run(["gh", *args], cwd=os.path.abspath(root),
                              capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"gh failed to run: {exc}"
    if proc.returncode != 0:
        lines = proc.stderr.strip().splitlines()
        detail = lines[0] if lines else "gh command failed"
        return None, f"{detail} — {GH_HELP}"
    try:
        return json.loads(proc.stdout or "null"), None
    except ValueError:
        return None, "gh returned non-JSON output"


def list_prs(root: str = ".") -> dict:
    """Open PRs for the repo at *root*: number, title, author, branch, url."""
    data, err = _run_gh(
        ["pr", "list", "--json", "number,title,author,headRefName,updatedAt,url"],
        root)
    if err is not None:
        return {"error": err}
    prs = []
    for p in data if isinstance(data, list) else []:
        if not isinstance(p, dict):
            continue
        author = p.get("author")
        prs.append({
            "number": p.get("number"),
            "title": p.get("title"),
            "author": author.get("login") if isinstance(author, dict) else None,
            "branch": p.get("headRefName"),
            "updated": p.get("updatedAt"),
            "url": p.get("url"),
        })
    return {"count": len(prs), "prs": prs}


def pr_files(root: str, number: int) -> tuple[list[str] | None, dict | None, str | None]:
    """Changed files for one PR -> (files, meta, error)."""
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        return None, None, f"pr number must be a positive integer: {number!r}"
    data, err = _run_gh(
        ["pr", "view", str(number), "--json", "number,title,url,files"], root)
    if err is not None:
        return None, None, err
    data = data if isinstance(data, dict) else {}
    files = [f["path"] for f in data.get("files") or []
             if isinstance(f, dict) and isinstance(f.get("path"), str)]
    return files, data, None


def pr_impact(g: SymbolGraph, number: int, root: str = ".",
              depth: int = alg_mod.AFFECTED_DEFAULT_DEPTH) -> dict:
    """Blast radius of one PR: its changed files fed through affected()."""
    files, data, err = pr_files(root, number)
    if err is not None:
        return {"error": err}
    assert files is not None and data is not None
    impact = alg_mod.affected(g, files=files, root=root, depth=depth)
    return {"number": data.get("number", number), "title": data.get("title"),
            "url": data.get("url"), **impact}


def worktree_map(root: str = ".") -> dict:
    """Map git worktrees via ``git worktree list --porcelain`` (no deps)."""
    if shutil.which("git") is None:
        return {"error": "git not found"}
    try:
        proc = subprocess.run(
            ["git", "-C", os.path.abspath(root), "worktree", "list",
             "--porcelain"],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": f"git worktree failed: {exc}"}
    if proc.returncode != 0:
        lines = proc.stderr.strip().splitlines()
        return {"error": lines[0] if lines else "git worktree list failed"}
    worktrees = []
    cur: dict = {}
    for line in proc.stdout.splitlines():
        if not line.strip():
            if cur:
                worktrees.append(cur)
                cur = {}
            continue
        if line.startswith("worktree "):
            cur["path"] = line[len("worktree "):]
        elif line.startswith("HEAD "):
            cur["head"] = line[len("HEAD "):]
        elif line.startswith("branch "):
            cur["branch"] = line[len("branch "):]
        elif line == "bare":
            cur["bare"] = True
        elif line == "detached":
            cur["detached"] = True
    if cur:
        worktrees.append(cur)
    return {"count": len(worktrees), "worktrees": worktrees}


def _affected_files(impact: dict) -> set[str]:
    files: set[str] = set(impact.get("changed_files") or [])
    for group in impact.get("affected") or []:
        for s in group.get("symbols") or []:
            f = s.get("file")
            if isinstance(f, str):
                files.add(f)
    return files


def triage_prs(g: SymbolGraph, root: str = ".",
               depth: int = alg_mod.AFFECTED_DEFAULT_DEPTH,
               limit: int = 20) -> dict:
    """Structural PR triage — no LLM.

    Ranks open PRs by blast-radius size (affected symbols) and flags pairs
    whose affected-file sets overlap as merge-conflict *hints*.
    """
    listed = list_prs(root)
    if "error" in listed:
        return listed
    ranked = []
    file_sets: dict[int, set[str]] = {}
    for p in listed.get("prs") or []:
        num = p.get("number")
        if not isinstance(num, int):
            continue
        impact = pr_impact(g, num, root=root, depth=depth)
        if "error" in impact:
            ranked.append({**p, "error": impact["error"], "blast": 0})
            continue
        blast = int(impact.get("total") or 0)
        file_sets[num] = _affected_files(impact)
        ranked.append({
            **p,
            "blast": blast,
            "changed_files": impact.get("changed_files") or [],
            "matched_files": impact.get("matched_files") or [],
        })
    ranked.sort(key=lambda r: (-int(r.get("blast") or 0), int(r.get("number") or 0)))
    ranked = ranked[:max(0, limit)]
    overlaps = []
    nums = [r["number"] for r in ranked if isinstance(r.get("number"), int)
            and r["number"] in file_sets]
    for i, a in enumerate(nums):
        for b in nums[i + 1:]:
            shared = sorted(file_sets[a] & file_sets[b])
            if shared:
                overlaps.append({
                    "a": a, "b": b, "shared_files": shared[:20],
                    "shared_count": len(shared),
                })
    overlaps.sort(key=lambda o: (-o["shared_count"], o["a"], o["b"]))
    return {
        "count": len(ranked),
        "prs": ranked,
        "overlap_hints": overlaps,
        "worktrees": worktree_map(root),
    }


def conflict_hints(g: SymbolGraph, root: str = ".",
                   depth: int = alg_mod.AFFECTED_DEFAULT_DEPTH) -> dict:
    """Just the overlapping-affected-file pairs from triage_prs."""
    result = triage_prs(g, root=root, depth=depth)
    if "error" in result:
        return result
    return {"overlap_hints": result.get("overlap_hints") or [],
            "count": len(result.get("overlap_hints") or [])}
