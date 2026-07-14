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

import hashlib
import json
import os
import time

from . import extract
from . import ignore as ignore_mod
from . import manifest as manifest_mod

GRAPH_VERSION = 1
CACHE_DIR = ".eap"
CACHE_FILE = "graph.json"
FILE_INDEX_FILE = "index.json"  # per-file fingerprint + symbol cache (incremental)
FILE_INDEX_VERSION = 1
COMMUNITY_FILE = "communities.json"  # label-propagation ids persisted at build

DEFAULT_IGNORE = frozenset({
    ".git", "node_modules", ".eap", "dist", "build", "__pycache__",
    ".venv", "venv", ".mypy_cache", ".pytest_cache", ".next", "target",
    "vendor", ".tox", "coverage", ".cache",
})

# A ref name matching more than this many definitions is too ambiguous to link
# across files (think `get`, `run`, `init`); same-file matches still link.
AMBIGUOUS_REF_MAX = 8

CALLABLE_KINDS = frozenset({"function", "method"})
# Relations emitted from symbol.inherits / symbol.implements lists.
TYPE_RELATIONS = frozenset({"inherits", "implements"})


class SymbolGraph:
    """Directed multigraph over symbols, adjacency-list backed."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}      # id -> {name, kind, file, line}
        self.edges: list[dict] = []           # {source, target, relation, provenance}
        self.out: dict[str, list[int]] = {}   # id -> indexes into self.edges
        self.inc: dict[str, list[int]] = {}
        self.meta: dict = {}
        self._edge_seen: set[tuple] = set()
        # rel -> {size, mtime_ns, sha256, symbols}: the per-file fingerprint +
        # extracted-symbol cache that powers incremental rebuilds. Populated by
        # build(); persisted alongside graph.json by build_and_save().
        self.file_index: dict[str, dict] = {}
        # Cross-query memoization (C1): each is a pure function of this graph's
        # immutable post-build state, so it is safe to cache for the object's
        # lifetime. A rebuild returns a NEW SymbolGraph, so object identity
        # invalidates every cache — no manual invalidation is ever needed.
        self._node_tokens_cache: dict[str, set] = {}
        self._idf_cache: dict[str, float] = {}
        self._trigram_index: dict | None = None

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


def _within(root_real: str, path_real: str) -> bool:
    """True if *path_real* is *root_real* itself or nested beneath it."""
    if path_real == root_real:
        return True
    return path_real.startswith(root_real + os.sep)


def iter_source_files(root: str, ignore=DEFAULT_IGNORE):
    """Yield (abspath, relpath) for supported source + manifest files under root.

    Symlinks are not followed: a symlinked directory is not descended into and
    a symlinked file is skipped, so out-of-tree source can never be indexed
    under an in-tree path. A realpath containment check backstops both.

    On top of the hardcoded *ignore* set (which always prunes first, so no
    ignore-file negation can re-include `.git` and friends), gitignore-syntax
    rules from every ``.gitignore`` / ``.eapignore`` under the tree are
    honoured — nested files are directory-scoped; ``.eapignore`` wins on
    conflicts with a sibling ``.gitignore``.
    """
    root = os.path.abspath(root)
    root_real = os.path.realpath(root)
    rules = ignore_mod.load_rules(root)
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        prefix = "" if rel_dir == "." else rel_dir + "/"
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in ignore and not d.startswith(".")
            and not os.path.islink(os.path.join(dirpath, d))
            and not rules.ignored(prefix + d, True)
        )
        for fname in sorted(filenames):
            ext = os.path.splitext(fname)[1].lower()
            is_code = ext in extract.CODE_EXTENSIONS
            is_manifest = fname in manifest_mod.MANIFEST_NAMES
            if not (is_code or is_manifest):
                continue
            rel = prefix + fname
            if rules.ignored(rel, False):
                continue
            ap = os.path.join(dirpath, fname)
            if os.path.islink(ap):
                continue  # symlink may point outside the tree
            if not _within(root_real, os.path.realpath(ap)):
                continue  # backstop: resolved target escaped the root
            yield ap, rel


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------


def _file_sha(abspath: str) -> str:
    """sha256 hex of a source file's bytes, matching extract.extract_file_hashed.

    An oversized (never-read) or unreadable file hashes to ``""`` — exactly the
    sentinel the fingerprint writer stores — so comparisons stay consistent.
    """
    try:
        if os.path.getsize(abspath) > extract.MAX_FILE_BYTES:
            return ""
        with open(abspath, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return ""


def build(root: str, ignore=DEFAULT_IGNORE, incremental: bool = False,
          verify_hash: bool = True) -> SymbolGraph:
    """Index *root* into a SymbolGraph (two passes: extract, then resolve).

    When *incremental* is true, a prior per-file fingerprint cache
    (``.eap/index.json``) is consulted: a file whose (size, mtime_ns) is
    unchanged reuses its cached symbols without re-reading or re-extracting;
    only new/changed files are read. The resolve pass (pass 2) is always redone
    in full over the union of symbols, so the result is byte-for-byte identical
    to a non-incremental build of the same tree — incremental only skips
    redundant extraction work, never changes the graph. Deleted files simply
    fall out (they no longer appear in the walk).
    """
    g = SymbolGraph()
    old_index = load_file_index(root) if incremental else {}
    per_file: dict[str, list[tuple[str, dict]]] = {}  # rel -> [(node_id, sym)]
    files = 0

    # pass 1 — extract symbols (reusing unchanged files), create nodes. The walk
    # is sorted (iter_source_files) so node insertion order — and therefore the
    # `@line` id disambiguation — is identical whether or not files were reused.
    for abspath, rel in iter_source_files(root, ignore):
        try:
            st = os.stat(abspath)
            size, mtime_ns = st.st_size, st.st_mtime_ns
        except OSError:
            continue
        prev = old_index.get(rel)
        if prev and prev.get("size") == size and prev.get("mtime_ns") == mtime_ns:
            symbols = prev["symbols"]  # unchanged (size+mtime): reuse cached extraction
            sha = prev.get("sha256", "")
        elif (verify_hash and prev and prev.get("size") == size
              and prev.get("sha256") and _file_sha(abspath) == prev["sha256"]):
            # size matches, mtime bumped, but content is byte-identical (e.g. a
            # git checkout that only touched mtimes): reuse the cached symbols and
            # refresh the fingerprint's mtime — no re-extraction. (C4)
            symbols = prev["symbols"]
            sha = prev["sha256"]
        else:
            if manifest_mod.is_manifest(rel):
                symbols = manifest_mod.extract_manifest(abspath, rel)
                sha = _file_sha(abspath)
            else:
                symbols, sha, size = extract.extract_file_hashed(abspath, rel)
        # Record a fingerprint for every walked source file (even 0-symbol ones)
        # so the next incremental build can skip them without a read.
        g.file_index[rel] = {"size": size, "mtime_ns": mtime_ns,
                             "sha256": sha, "symbols": symbols}
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
            if sym.get("kind") == "dependency":
                g.add_edge(mod_id, nid, "depends_on", "EXTRACTED")
        per_file[rel] = rows

    # name index: short name -> [node ids] over definitions + modules
    index: dict[str, list[str]] = {}
    for nid, node in g.nodes.items():
        if node["kind"] in ("import", "dependency"):
            continue
        short = node["name"].rsplit(".", 1)[-1]
        index.setdefault(short, []).append(nid)

    # pass 2 — resolve refs to edges
    for rel, rows in per_file.items():
        for nid, sym in rows:
            src_kind = sym["kind"]
            inherits = set(sym.get("inherits") or ())
            implements = set(sym.get("implements") or ())
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
                    if ref in inherits:
                        relation = "inherits"
                    elif ref in implements:
                        relation = "implements"
                    elif src_kind == "import":
                        relation = "imports"
                    elif src_kind == "dependency":
                        relation = "depends_on"
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
        "incremental": bool(incremental),
    }
    return g


# ---------------------------------------------------------------------------
# JSON cache (node-link format)
# ---------------------------------------------------------------------------


def cache_path(root: str) -> str:
    return os.path.join(os.path.abspath(root), CACHE_DIR, CACHE_FILE)


def file_index_path(root: str) -> str:
    return os.path.join(os.path.abspath(root), CACHE_DIR, FILE_INDEX_FILE)


def communities_path(root: str) -> str:
    return os.path.join(os.path.abspath(root), CACHE_DIR, COMMUNITY_FILE)


def _stamp_communities(g: SymbolGraph) -> dict[str, int]:
    """Run label-propagation and store community ids on nodes. Returns mapping."""
    # Local import avoids a graph <-> algorithms cycle at module load.
    from . import algorithms as alg_mod
    result = alg_mod.communities(g)
    mapping = result.get("node_community") or {}
    for nid, cid in mapping.items():
        if nid in g.nodes and isinstance(cid, int) and not isinstance(cid, bool):
            g.nodes[nid]["community"] = cid
    g.meta["communities"] = result.get("total_communities", 0)
    return mapping


def save_communities(root: str, mapping: dict[str, int]) -> str:
    path = communities_path(root)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"node_community": mapping}, fh, indent=1)
    os.replace(tmp, path)
    return path


def load_communities(root: str) -> dict[str, int]:
    """{node_id: community_id}; missing/malformed → {}."""
    path = communities_path(root)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        raw = data.get("node_community") if isinstance(data, dict) else None
        if not isinstance(raw, dict):
            return {}
        out: dict[str, int] = {}
        for k, v in raw.items():
            if isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool):
                out[k] = v
        return out
    except Exception:
        return {}


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


class CacheFormatError(ValueError):
    """A graph cache is structurally invalid, wrong-shaped, or unsafe.

    Subclasses ValueError so ``load_or_build`` treats it as a corrupt cache and
    rebuilds from source rather than crashing or trusting the file.
    """


def _is_safe_relpath(p) -> bool:
    """True only for a plain in-tree relative path (no absolute, no ``..``).

    A cache is untrusted input: a node whose ``file`` is absolute (``/etc/x``,
    ``C:\\x``, ``//host/share``) or contains a ``..`` component would hand the
    agent an attacker-chosen file:line pointer outside the indexed tree.
    """
    if not isinstance(p, str) or not p:
        return False
    if _has_control_char(p):
        return False  # a newline in `file` forges a second pointer line
    s = p.replace("\\", "/")
    if s.startswith("/") or s.startswith("//") or (len(s) >= 2 and s[1] == ":"):
        return False  # posix-absolute, UNC, or windows drive
    return all(seg != ".." for seg in s.split("/"))


# NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR — not < 0x20, but Python's
# str.splitlines() and many renderers treat them as line breaks, so they could
# forge a pointer line just like \n. Reject them alongside the ASCII controls.
_UNICODE_LINE_BREAKS = "\x85\u2028\u2029"


def _has_control_char(s: str) -> bool:
    return any(ord(c) < 0x20 or ord(c) == 0x7f or c in _UNICODE_LINE_BREAKS
               for c in s)


def _check_str_field(v, what: str) -> str:
    """Validate a cache string field that is echoed into pointer / neighbor /
    god-node output. It must be a plain string with no control characters —
    otherwise a poisoned cache can splice a newline into ``name``/``kind``/
    ``relation`` and forge an extra, attacker-chosen output line (an out-of-tree
    ``file:line`` pointer). ``build()`` only ever emits identifier- and
    relation-class strings, so this rejects no legitimately-built cache.
    """
    if not isinstance(v, str):
        raise CacheFormatError(f"{what} must be a string: {v!r}")
    if _has_control_char(v):
        raise CacheFormatError(f"{what} contains control characters: {v!r}")
    return v


def load(path: str) -> SymbolGraph:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise CacheFormatError("graph cache must be a JSON object")
    nodes = data.get("nodes", [])
    links = data.get("links", [])
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise CacheFormatError("graph cache 'nodes'/'links' must be arrays")
    meta = data.get("meta", {})
    g = SymbolGraph()
    g.meta = meta if isinstance(meta, dict) else {}
    for node in nodes:
        if not isinstance(node, dict):
            raise CacheFormatError("each node must be an object")
        try:
            nid, name, kind = node["id"], node["name"], node["kind"]
            file, line = node["file"], node["line"]
        except (KeyError, TypeError) as exc:
            raise CacheFormatError(f"node missing field: {exc}") from exc
        if not isinstance(nid, str):
            raise CacheFormatError("node id must be a string")
        if not _is_safe_relpath(file):
            raise CacheFormatError(f"unsafe node file path: {file!r}")
        # `line` is echoed verbatim into pointer() as f"{file}:{line}"; an
        # attacker-controlled non-int (e.g. "1\n/etc/passwd:1") would forge a
        # pointer. build() only ever emits line >= 1, so this rejects no valid
        # cache. bool is an int subclass — exclude it explicitly.
        if not isinstance(line, int) or isinstance(line, bool) or line < 1:
            raise CacheFormatError(f"node line must be a positive integer: {line!r}")
        # name/kind reach pointer/neighbor/god-node output verbatim — validate
        # them the same way as file/line so a newline can't forge an extra line.
        _check_str_field(name, "node name")
        _check_str_field(kind, "node kind")
        entry = {"name": name, "kind": kind, "file": file, "line": line}
        community = node.get("community")
        if isinstance(community, int) and not isinstance(community, bool) and community >= 0:
            entry["community"] = community
        g.nodes[nid] = entry
        g.out.setdefault(nid, [])
        g.inc.setdefault(nid, [])
    for link in links:
        if not isinstance(link, dict):
            raise CacheFormatError("each link must be an object")
        try:
            source, target, relation = link["source"], link["target"], link["relation"]
        except (KeyError, TypeError) as exc:
            raise CacheFormatError(f"link missing field: {exc}") from exc
        # source/target/relation/provenance all reach neighbor/query output.
        # Default a missing provenance so neighbors() can't KeyError, and reject
        # control chars so no field can splice a forged output line.
        provenance = link.get("provenance", "")
        _check_str_field(source, "link source")
        _check_str_field(target, "link target")
        _check_str_field(relation, "link relation")
        _check_str_field(provenance, "link provenance")
        # Referential integrity: build() only ever emits edges between defined
        # nodes (add_edge enforces it). A poisoned cache with a dangling
        # source/target loads fine here but then crashes the read layer
        # (query/neighbors do g.nodes[endpoint]) with an UNCAUGHT KeyError that
        # load_or_build's try can't catch — reject it so the cache rebuilds.
        if source not in g.nodes or target not in g.nodes:
            raise CacheFormatError(
                f"link endpoint is not a defined node: {source!r} -> {target!r}")
        link["provenance"] = provenance
        idx = len(g.edges)
        g.edges.append(link)
        g._edge_seen.add((source, target, relation))
        g.out.setdefault(source, []).append(idx)
        g.inc.setdefault(target, []).append(idx)
    return g


def build_and_save(root: str, ignore=DEFAULT_IGNORE,
                   incremental: bool = False) -> tuple[SymbolGraph, str]:
    g = build(root, ignore, incremental=incremental)
    mapping = _stamp_communities(g)
    path = save(g, cache_path(root))
    save_file_index(g, file_index_path(root))  # persist fingerprints for next --update
    save_communities(root, mapping)
    return g, path


def _sources_changed(root: str, ignore=DEFAULT_IGNORE) -> bool:
    """True if the on-disk source tree no longer matches the fingerprint cache.

    Walks ``iter_source_files`` and compares each file's byte-size AND content
    hash against ``index.json``; also flags added or removed files. Content is
    hashed (not merely mtime-compared) so a same-size, mtime-preserved edit is
    still detected — the whole point of persisting sha256 (C4). A missing or
    unusable fingerprint cache is treated as changed, forcing a rebuild.
    """
    index = load_file_index(root)
    if not index:
        return True
    remaining = set(index)
    for abspath, rel in iter_source_files(root, ignore):
        prev = index.get(rel)
        if prev is None:
            return True  # a file the cache never saw
        remaining.discard(rel)
        try:
            size = os.path.getsize(abspath)
        except OSError:
            return True
        if prev.get("size") != size or _file_sha(abspath) != prev.get("sha256", ""):
            return True
    return bool(remaining)  # any indexed file no longer on disk


def load_or_build(root: str, rebuild: bool = False,
                  verify_hash: bool = True) -> SymbolGraph:
    """Cache-first load; rebuilds when the cache is missing, rejected, or stale.

    With *verify_hash* on (default), a loaded cache is only returned after a
    stat+hash walk confirms the source tree is unchanged (C4); otherwise the
    graph is rebuilt from source so a stale cache is never served. When the graph
    cache is simply missing/rejected, the rebuild reuses the per-file fingerprint
    cache (``.eap/index.json``) so only changed files are re-extracted; a
    missing/poisoned fingerprint cache degrades to a full build.
    """
    path = cache_path(root)
    if not rebuild and os.path.isfile(path):
        try:
            g = load(path)
        except Exception:
            # A cache is untrusted input and build_and_save (below) is an
            # unconditional rebuild fallback, so ANY load failure —
            # stale/corrupt/wrong-shaped/unsafe, or a RecursionError from a
            # deeply-nested JSON payload — is caught and rebuilt from source.
            g = None
        if g is not None:
            if not (verify_hash and _sources_changed(root)):
                return g
            # The cache loaded fine but the sources changed underneath it. A same
            # -size, mtime-preserved edit fools incremental reuse (its first
            # branch keys on size+mtime), so a full rebuild is the only correct
            # answer here.
            g, _ = build_and_save(root, incremental=False)
            return g
    g, _ = build_and_save(root, incremental=True)
    return g


# ---------------------------------------------------------------------------
# per-file fingerprint cache (incremental indexing)
# ---------------------------------------------------------------------------


def save_file_index(g: SymbolGraph, path: str) -> str:
    """Atomically write the per-file fingerprint + symbol cache."""
    data = {"version": FILE_INDEX_VERSION, "files": g.file_index}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)
    return path


def _validate_symbol(sym, rel: str) -> dict:
    """Validate one cached symbol from the (untrusted) fingerprint cache.

    Applies the same discipline as the graph-cache loader: strings carry no
    control characters (a spliced newline could forge an output line once the
    symbol reaches a node/pointer), ``line`` is a positive int, ``file`` matches
    the entry's own relpath, and ``refs`` is a list of clean strings. Raises
    CacheFormatError on any violation so the whole fingerprint cache is dropped
    and extraction falls back to reading source.
    """
    if not isinstance(sym, dict):
        raise CacheFormatError("cached symbol must be an object")
    try:
        name, kind, file, line = sym["name"], sym["kind"], sym["file"], sym["line"]
        refs = sym["refs"]
    except (KeyError, TypeError) as exc:
        raise CacheFormatError(f"cached symbol missing field: {exc}") from exc
    _check_str_field(name, "symbol name")
    _check_str_field(kind, "symbol kind")
    if not _is_safe_relpath(file) or file != rel:
        raise CacheFormatError(f"cached symbol file not in-tree/consistent: {file!r}")
    if not isinstance(line, int) or isinstance(line, bool) or line < 1:
        raise CacheFormatError(f"cached symbol line must be a positive int: {line!r}")
    if not isinstance(refs, list):
        raise CacheFormatError("cached symbol refs must be a list")
    for r in refs:
        _check_str_field(r, "symbol ref")
    out = {"name": name, "kind": kind, "file": file, "line": line, "refs": refs}
    for key in ("inherits", "implements"):
        vals = sym.get(key)
        if vals is None:
            continue
        if not isinstance(vals, list):
            raise CacheFormatError(f"cached symbol {key} must be a list")
        clean = []
        for r in vals:
            _check_str_field(r, f"symbol {key}")
            clean.append(r)
        out[key] = clean
    return out


def load_file_index(root: str) -> dict:
    """Load + validate the fingerprint cache, or return {} if absent/unusable.

    The cache is untrusted input, so every failure mode — missing file,
    non-UTF-8/JSON, wrong shape, unsafe relpath, bad fingerprint types, poisoned
    symbol, or a RecursionError from a deeply nested payload — degrades to {} (a
    full extraction), never a crash and never a trusted bad pointer.
    """
    path = file_index_path(root)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {}
        files = data.get("files")
        if not isinstance(files, dict):
            return {}
        out: dict[str, dict] = {}
        for rel, entry in files.items():
            if not isinstance(rel, str) or not _is_safe_relpath(rel):
                return {}  # a poisoned key would be trusted as an in-tree path
            if not isinstance(entry, dict):
                return {}
            size, mtime_ns = entry.get("size"), entry.get("mtime_ns")
            sha = entry.get("sha256", "")
            symbols = entry.get("symbols", [])
            if (not isinstance(size, int) or isinstance(size, bool) or size < 0
                    or not isinstance(mtime_ns, int) or isinstance(mtime_ns, bool)
                    or not isinstance(sha, str) or _has_control_char(sha)
                    or not isinstance(symbols, list)):
                return {}
            out[rel] = {
                "size": size, "mtime_ns": mtime_ns, "sha256": sha,
                "symbols": [_validate_symbol(s, rel) for s in symbols],
            }
        return out
    except Exception:
        # untrusted input: any failure (incl. RecursionError / CacheFormatError)
        # means "no usable fingerprint cache" → re-extract everything.
        return {}
