"""Symbol graph: build over a directory, hand-rolled adjacency lists, JSON cache.

Nodes are symbols keyed by qualified id ``<relpath>::<qualname>`` plus one
``module`` node per source file (id = relpath). Edges carry a relation
(defines | calls | references | imports) and provenance:

  EXTRACTED — the reference text is explicit in the source AND resolves within
              the same file (or is a structural defines edge).
  INFERRED  — the reference is explicit but was resolved to a definition in a
              *different* file purely by name matching.

The graph persists as node-link JSON under ``<root>/.eap/graph.json`` — a
cache, never a second source of truth.
"""

from __future__ import annotations

import json
import os
import time

from . import extract

GRAPH_VERSION = 1
CACHE_DIR = ".eap"
CACHE_FILE = "graph.json"

DEFAULT_IGNORE = frozenset({
    ".git", "node_modules", ".eap", "dist", "build", "__pycache__",
    ".venv", "venv", ".mypy_cache", ".pytest_cache", ".next", "target",
    "vendor", ".tox", "coverage", ".cache",
})

# A ref name matching more than this many definitions is too ambiguous to link
# across files (think `get`, `run`, `init`); same-file matches still link.
AMBIGUOUS_REF_MAX = 8

CALLABLE_KINDS = frozenset({"function", "method"})


class SymbolGraph:
    """Directed multigraph over symbols, adjacency-list backed."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}      # id -> {name, kind, file, line}
        self.edges: list[dict] = []           # {source, target, relation, provenance}
        self.out: dict[str, list[int]] = {}   # id -> indexes into self.edges
        self.inc: dict[str, list[int]] = {}
        self.meta: dict = {}
        self._edge_seen: set[tuple] = set()

    # -- construction -------------------------------------------------------

    def add_node(self, node_id: str, name: str, kind: str, file: str, line: int) -> str:
        if node_id in self.nodes:
            # collision (e.g. import shadowing a def name): disambiguate by line
            node_id = f"{node_id}@{line}"
            if node_id in self.nodes:
                return node_id
        self.nodes[node_id] = {"name": name, "kind": kind, "file": file, "line": line}
        self.out.setdefault(node_id, [])
        self.inc.setdefault(node_id, [])
        return node_id

    def add_edge(self, source: str, target: str, relation: str, provenance: str) -> bool:
        if source not in self.nodes or target not in self.nodes or source == target:
            return False
        key = (source, target, relation)
        if key in self._edge_seen:
            return False
        self._edge_seen.add(key)
        idx = len(self.edges)
        self.edges.append({
            "source": source, "target": target,
            "relation": relation, "provenance": provenance,
        })
        self.out[source].append(idx)
        self.inc[target].append(idx)
        return True

    # -- reads ---------------------------------------------------------------

    def degree(self, node_id: str) -> int:
        return len(self.out.get(node_id, ())) + len(self.inc.get(node_id, ()))

    def neighbor_edges(self, node_id: str, direction: str = "both") -> list[dict]:
        idxs: list[int] = []
        if direction in ("out", "both"):
            idxs += self.out.get(node_id, [])
        if direction in ("in", "both"):
            idxs += self.inc.get(node_id, [])
        return [self.edges[i] for i in idxs]

    def neighbors(self, node_id: str) -> list[str]:
        seen, order = set(), []
        for e in self.neighbor_edges(node_id):
            for nid in (e["target"], e["source"]):
                if nid != node_id and nid not in seen:
                    seen.add(nid)
                    order.append(nid)
        return order

    def pointer(self, node_id: str) -> str:
        n = self.nodes[node_id]
        return f"{n['file']}:{n['line']}"


# ---------------------------------------------------------------------------
# directory walk
# ---------------------------------------------------------------------------


def iter_source_files(root: str, ignore=DEFAULT_IGNORE):
    """Yield (abspath, relpath) for supported source files under root."""
    root = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames if d not in ignore and not d.startswith(".")
        )
        for fname in sorted(filenames):
            if os.path.splitext(fname)[1].lower() in extract.CODE_EXTENSIONS:
                ap = os.path.join(dirpath, fname)
                yield ap, os.path.relpath(ap, root).replace(os.sep, "/")


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------


def build(root: str, ignore=DEFAULT_IGNORE) -> SymbolGraph:
    """Index *root* into a SymbolGraph (two passes: extract, then resolve)."""
    g = SymbolGraph()
    per_file: dict[str, list[tuple[str, dict]]] = {}  # rel -> [(node_id, sym)]
    files = 0

    # pass 1 — extract symbols, create nodes
    for abspath, rel in iter_source_files(root, ignore):
        symbols = extract.extract_file(abspath, rel)
        if not symbols:
            continue
        files += 1
        mod_id = g.add_node(rel, os.path.splitext(os.path.basename(rel))[0],
                            "module", rel, 1)
        rows: list[tuple[str, dict]] = []
        for sym in symbols:
            nid = g.add_node(f"{rel}::{sym['name']}", sym["name"], sym["kind"],
                             rel, sym["line"])
            rows.append((nid, sym))
            g.add_edge(mod_id, nid, "defines", "EXTRACTED")
        per_file[rel] = rows

    # name index: short name -> [node ids] over definitions + modules
    index: dict[str, list[str]] = {}
    for nid, node in g.nodes.items():
        if node["kind"] == "import":
            continue
        short = node["name"].rsplit(".", 1)[-1]
        index.setdefault(short, []).append(nid)

    # pass 2 — resolve refs to edges
    for rel, rows in per_file.items():
        for nid, sym in rows:
            src_kind = sym["kind"]
            for ref in dict.fromkeys(sym["refs"]):  # dedupe, keep order
                targets = index.get(ref, [])
                if not targets:
                    continue
                same_file = [t for t in targets if g.nodes[t]["file"] == rel]
                cross = [t for t in targets if g.nodes[t]["file"] != rel]
                if len(targets) > AMBIGUOUS_REF_MAX:
                    cross = []  # too common a name to trust across files
                for t, provenance in (
                    [(t, "EXTRACTED") for t in same_file]
                    + [(t, "INFERRED") for t in cross]
                ):
                    if src_kind == "import":
                        relation = "imports"
                    elif g.nodes[t]["kind"] in CALLABLE_KINDS:
                        relation = "calls"
                    else:
                        relation = "references"
                    g.add_edge(nid, t, relation, provenance)

    g.meta = {
        "version": GRAPH_VERSION,
        "root": os.path.abspath(root),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "files": files,
        "nodes": len(g.nodes),
        "edges": len(g.edges),
    }
    return g


# ---------------------------------------------------------------------------
# JSON cache (node-link format)
# ---------------------------------------------------------------------------


def cache_path(root: str) -> str:
    return os.path.join(os.path.abspath(root), CACHE_DIR, CACHE_FILE)


def save(g: SymbolGraph, path: str) -> str:
    data = {
        "meta": g.meta,
        "nodes": [{"id": nid, **node} for nid, node in g.nodes.items()],
        "links": g.edges,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)
    return path


def load(path: str) -> SymbolGraph:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    g = SymbolGraph()
    g.meta = data.get("meta", {})
    for node in data.get("nodes", []):
        nid = node["id"]
        g.nodes[nid] = {"name": node["name"], "kind": node["kind"],
                        "file": node["file"], "line": node["line"]}
        g.out.setdefault(nid, [])
        g.inc.setdefault(nid, [])
    for link in data.get("links", []):
        idx = len(g.edges)
        g.edges.append(link)
        g._edge_seen.add((link["source"], link["target"], link["relation"]))
        g.out.setdefault(link["source"], []).append(idx)
        g.inc.setdefault(link["target"], []).append(idx)
    return g


def build_and_save(root: str, ignore=DEFAULT_IGNORE) -> tuple[SymbolGraph, str]:
    g = build(root, ignore)
    return g, save(g, cache_path(root))


def load_or_build(root: str, rebuild: bool = False) -> SymbolGraph:
    """Cache-first load; falls back to a fresh build (and saves it)."""
    path = cache_path(root)
    if not rebuild and os.path.isfile(path):
        try:
            return load(path)
        except (json.JSONDecodeError, KeyError, OSError):
            pass  # stale/corrupt cache: rebuild below
    g, _ = build_and_save(root)
    return g
