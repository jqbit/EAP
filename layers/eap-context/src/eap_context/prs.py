"""PR tooling over the `gh` CLI — subprocess only, never direct HTTP.

  list_prs(root)              — open PRs via `gh pr list --json ...`
  pr_impact(g, number, root)  — a PR's changed files -> affected() closure

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


def pr_impact(g: SymbolGraph, number: int, root: str = ".",
              depth: int = alg_mod.AFFECTED_DEFAULT_DEPTH) -> dict:
    """Blast radius of one PR: its changed files fed through affected()."""
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        return {"error": f"pr number must be a positive integer: {number!r}"}
    data, err = _run_gh(
        ["pr", "view", str(number), "--json", "number,title,url,files"], root)
    if err is not None:
        return {"error": err}
    data = data if isinstance(data, dict) else {}
    files = [f["path"] for f in data.get("files") or []
             if isinstance(f, dict) and isinstance(f.get("path"), str)]
    impact = alg_mod.affected(g, files=files, root=root, depth=depth)
    return {"number": data.get("number", number), "title": data.get("title"),
            "url": data.get("url"), **impact}
