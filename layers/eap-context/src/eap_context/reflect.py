"""Query log + reflect overlay: remember what was asked, bias what worked.

  log_query(root, tool, args, result) — append-only JSONL at
      <root>/.eap/context/querylog.jsonl (tool, args, top pointers, ts).
      Best-effort: a logging failure never fails the query.
  load_tags(root) / set_tags(...)     — persisted node-id tags at
      <root>/.eap/context/reflect.json. query.py applies them as a small
      scoring overlay: "preferred" boosts a seed, "contested" penalises it.

No LLM, no heuristics — the tags are set explicitly (by the agent or a human)
via the eap_graph_reflect tool. Both files are untrusted input on read and
degrade to nothing when malformed.
"""

from __future__ import annotations

import json
import os
import time

from .query import resolve_node

CONTEXT_DIR = os.path.join(".eap", "context")
QUERYLOG_FILE = "querylog.jsonl"
REFLECT_FILE = "reflect.json"
LESSONS_FILE = "LESSONS.md"  # optional human-readable preferred outcomes
TAGS = ("preferred", "contested")
LOG_TOP_RESULTS = 5


def context_dir(root: str) -> str:
    return os.path.join(os.path.abspath(root), CONTEXT_DIR)


def querylog_path(root: str) -> str:
    return os.path.join(context_dir(root), QUERYLOG_FILE)


def reflect_path(root: str) -> str:
    return os.path.join(context_dir(root), REFLECT_FILE)


def lessons_path(root: str) -> str:
    return os.path.join(os.path.abspath(root), ".eap", LESSONS_FILE)


def log_query(root: str, tool: str, args: dict, result: dict) -> None:
    """Append one query record. Best-effort by design: retrieval must keep
    working on a read-only checkout or a full disk, so every OSError is
    swallowed here and nowhere else."""
    pointers = result.get("pointers")
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "tool": tool,
        "args": args,
        "top": list(pointers[:LOG_TOP_RESULTS]) if isinstance(pointers, list) else [],
    }
    try:
        os.makedirs(context_dir(root), exist_ok=True)
        with open(querylog_path(root), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def load_tags(root: str) -> dict[str, str]:
    """{node_id: "preferred"|"contested"}; malformed input degrades to {}."""
    try:
        with open(reflect_path(root), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and v in TAGS}


def _write_lessons(root: str, tags: dict[str, str], g) -> str | None:
    """Rewrite ``.eap/LESSONS.md`` from preferred tags. Best-effort."""
    preferred = sorted(nid for nid, t in tags.items() if t == "preferred")
    if not preferred:
        # leave an existing file alone when nothing is preferred
        return None
    lines = [
        "# EAP-Context lessons",
        "",
        "Preferred symbols (from `eap_graph_reflect`). Structural only — no LLM.",
        "",
    ]
    for nid in preferred:
        n = g.nodes.get(nid)
        if not n:
            lines.append(f"- `{nid}`")
            continue
        lines.append(
            f"- `{n['name']}` [{n['kind']}] — {n['file']}:{n['line']}")
    lines.append("")
    path = lessons_path(root)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
        os.replace(tmp, path)
        return path
    except OSError:
        return None


def set_tags(root: str, g, refs: list[str], tag: str,
             save_lessons: bool = True) -> dict:
    """Tag nodes (resolved by id or name) preferred/contested, or clear them.

    Persists atomically to reflect.json (same temp+rename discipline as the
    graph cache). Unresolvable refs are reported, not fatal. When
    *save_lessons* is true and any preferred tags remain, also rewrites
    ``.eap/LESSONS.md``.
    """
    if tag not in (*TAGS, "clear"):
        return {"error": f"tag must be one of {TAGS + ('clear',)}: {tag!r}"}
    tags = load_tags(root)
    resolved, unknown = [], []
    for ref in refs:
        nid = resolve_node(g, ref)
        if nid is None:
            unknown.append(ref)
            continue
        resolved.append(nid)
        if tag == "clear":
            tags.pop(nid, None)
        else:
            tags[nid] = tag
    path = reflect_path(root)
    os.makedirs(context_dir(root), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(tags, fh, indent=1)
    os.replace(tmp, path)
    lessons = _write_lessons(root, tags, g) if save_lessons else None
    return {"tag": tag, "nodes": resolved, "unknown": unknown, "tags": tags,
            "lessons": lessons}
