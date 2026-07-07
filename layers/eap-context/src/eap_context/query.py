"""Query the symbol graph: IDF/substring seed scoring + bounded BFS.

Returns a compact subgraph and file:line POINTERS — never file contents. The
agent opens the real file:line itself, so retrieval stays lossless.

God-node handling: hub symbols whose degree exceeds a cap are *included* in
results (they are usually the interesting spine) but never *expanded* during
BFS, so one utility symbol cannot drag its hundreds of callers into context.
"""

from __future__ import annotations

import math
import re
from collections import deque

from .graph import SymbolGraph

DEFAULT_DEPTH = 3
DEFAULT_LIMIT = 20
MAX_SEEDS = 5

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens; camelCase and snake_case both split."""
    return _TOKEN_RE.findall(_CAMEL_RE.sub(" ", text).lower())


def _node_tokens(g: SymbolGraph, nid: str) -> set[str]:
    n = g.nodes[nid]
    return set(tokenize(n["name"])) | set(tokenize(n["file"].rsplit("/", 1)[-1]))


# ---------------------------------------------------------------------------
# god nodes
# ---------------------------------------------------------------------------


def god_node_threshold(g: SymbolGraph) -> int:
    """Degree above which a node counts as a hub: max(10, mean + 2*stdev)."""
    if not g.nodes:
        return 10
    degs = [g.degree(nid) for nid in g.nodes]
    mean = sum(degs) / len(degs)
    var = sum((d - mean) ** 2 for d in degs) / len(degs)
    return max(10, math.ceil(mean + 2 * math.sqrt(var)))


def god_nodes(g: SymbolGraph, top: int = 10, threshold: int | None = None) -> list[dict]:
    """The most-connected symbols — what everything flows through."""
    thr = god_node_threshold(g) if threshold is None else threshold
    hubs = sorted(
        ((g.degree(nid), nid) for nid in g.nodes if g.degree(nid) >= thr),
        reverse=True,
    )[:top]
    return [
        {"id": nid, "degree": deg, "pointer": g.pointer(nid), **g.nodes[nid]}
        for deg, nid in hubs
    ]


# ---------------------------------------------------------------------------
# seed scoring
# ---------------------------------------------------------------------------


def seed_scores(g: SymbolGraph, text: str) -> list[tuple[float, str]]:
    """Score every node against the query: exact-token IDF + substring credit."""
    q_tokens = [t for t in dict.fromkeys(tokenize(text)) if t]
    if not q_tokens or not g.nodes:
        return []
    node_tokens = {nid: _node_tokens(g, nid) for nid in g.nodes}
    total = len(g.nodes)

    idf: dict[str, float] = {}
    for t in q_tokens:
        df = sum(1 for toks in node_tokens.values() if t in toks)
        idf[t] = math.log((total + 1) / (df + 1)) + 1.0

    scored: list[tuple[float, str]] = []
    for nid, toks in node_tokens.items():
        name_lc = g.nodes[nid]["name"].lower()
        score = 0.0
        for t in q_tokens:
            if t in toks:
                score += idf[t]
            elif len(t) >= 3 and t in name_lc:
                score += 0.5 * idf[t]
            elif len(t) >= 4 and any(
                (tok.startswith(t) or t.startswith(tok))
                and min(len(t), len(tok)) >= 4
                for tok in toks
            ):
                # prefix overlap: "pointers" ~ "pointer", "handler" ~ "handlers"
                score += 0.4 * idf[t]
        if score > 0:
            # light preference for definitions over imports/modules
            if g.nodes[nid]["kind"] in ("function", "method", "class"):
                score *= 1.2
            scored.append((score, nid))
    scored.sort(key=lambda p: (-p[0], p[1]))
    return scored


# ---------------------------------------------------------------------------
# query = seeds + bounded BFS with god-node cap
# ---------------------------------------------------------------------------


def query(
    g: SymbolGraph,
    text: str,
    depth: int = DEFAULT_DEPTH,
    limit: int = DEFAULT_LIMIT,
    degree_cap: int | None = None,
) -> dict:
    """Answer *text* with a compact subgraph + file:line pointers."""
    cap = god_node_threshold(g) if degree_cap is None else degree_cap
    scored = seed_scores(g, text)
    seeds = [nid for _, nid in scored[:MAX_SEEDS]]
    score_of = {nid: s for s, nid in scored}

    chosen: list[str] = []
    seen: set[str] = set()
    truncated = False
    frontier: deque[tuple[str, int]] = deque((s, 0) for s in seeds)
    while frontier:
        nid, dist = frontier.popleft()
        if nid in seen:
            continue
        seen.add(nid)
        if len(chosen) >= limit:
            truncated = True
            break
        chosen.append(nid)
        if dist >= depth:
            continue
        if g.degree(nid) > cap and nid not in seeds:
            continue  # god node: keep it, do not fan out through it
        for nb in g.neighbors(nid):
            if nb not in seen:
                frontier.append((nb, dist + 1))

    chosen_set = set(chosen)
    sub_edges = [
        e for e in g.edges
        if e["source"] in chosen_set and e["target"] in chosen_set
    ]
    nodes_out = [
        {
            "id": nid,
            **g.nodes[nid],
            "degree": g.degree(nid),
            "score": round(score_of.get(nid, 0.0), 4),
            "pointer": g.pointer(nid),
        }
        for nid in chosen
    ]
    pointers = [
        f"{g.pointer(nid)}  {g.nodes[nid]['name']} [{g.nodes[nid]['kind']}]"
        for nid in chosen
    ]
    return {
        "query": text,
        "depth": depth,
        "limit": limit,
        "degree_cap": cap,
        "seeds": seeds,
        "nodes": nodes_out,
        "edges": sub_edges,
        "pointers": pointers,
        "truncated": truncated,
    }


# ---------------------------------------------------------------------------
# neighbors / stats
# ---------------------------------------------------------------------------


def resolve_node(g: SymbolGraph, ref: str) -> str | None:
    """Resolve a node by exact id, then by exact/short name (first match wins)."""
    if ref in g.nodes:
        return ref
    for nid, n in g.nodes.items():
        if n["name"] == ref:
            return nid
    ref_lc = ref.lower()
    for nid, n in g.nodes.items():
        if n["name"].rsplit(".", 1)[-1].lower() == ref_lc:
            return nid
    return None


def neighbors(g: SymbolGraph, ref: str, direction: str = "both") -> dict:
    nid = resolve_node(g, ref)
    if nid is None:
        return {"node": None, "error": f"no symbol matching {ref!r}"}
    edges = g.neighbor_edges(nid, direction)
    out = []
    for e in edges:
        other = e["target"] if e["source"] == nid else e["source"]
        arrow = "->" if e["source"] == nid else "<-"
        out.append({
            "direction": arrow,
            "relation": e["relation"],
            "provenance": e["provenance"],
            "id": other,
            "name": g.nodes[other]["name"],
            "kind": g.nodes[other]["kind"],
            "pointer": g.pointer(other),
        })
    return {
        "node": {"id": nid, **g.nodes[nid], "degree": g.degree(nid),
                 "pointer": g.pointer(nid)},
        "neighbors": out,
    }


def stats(g: SymbolGraph) -> dict:
    kinds: dict[str, int] = {}
    for n in g.nodes.values():
        kinds[n["kind"]] = kinds.get(n["kind"], 0) + 1
    files = {n["file"] for n in g.nodes.values()}
    n_nodes = len(g.nodes)
    return {
        "nodes": n_nodes,
        "edges": len(g.edges),
        "files": len(files),
        "kinds": kinds,
        "avg_degree": round(2 * len(g.edges) / n_nodes, 3) if n_nodes else 0.0,
        "god_node_threshold": god_node_threshold(g),
        "meta": g.meta,
    }
