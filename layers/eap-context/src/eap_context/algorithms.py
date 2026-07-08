"""Deterministic graph algorithms over the symbol graph. Python stdlib only.

All three algorithms operate on the **undirected projection** of the graph:
every edge (whatever its relation/provenance/direction) becomes a plain
undirected link between its two endpoints. Results are POINTERS and node ids —
never file contents — consistent with the query layer.

Determinism is a hard requirement (the engine must be reproducible with no LLM
and no randomness), so:

  * neighbor iteration is always in sorted node-id order,
  * label propagation runs a fixed number of sweeps in sorted node order and
    breaks label ties by smallest label id,
  * Brandes betweenness iterates sources in sorted order.

  shortest_path(a, b)  — BFS over the undirected projection; node path pointers.
  communities()        — label-propagation community detection.
  centrality()         — Brandes betweenness, capped; degree fallback.
"""

from __future__ import annotations

from collections import defaultdict, deque

from .graph import SymbolGraph
from .query import resolve_node

# Above this node count, Brandes betweenness (O(V*E)) is too costly, so
# centrality("auto") falls back to O(V+E) degree centrality.
BETWEENNESS_NODE_CAP = 1500
# Fixed sweep count keeps label propagation deterministic and bounded.
COMMUNITY_ITERATIONS = 10


def undirected_adj(g: SymbolGraph) -> dict[str, list[str]]:
    """Undirected adjacency with sorted, de-duplicated neighbor lists.

    Built once from ``g.edges`` in O(V + E); self-loops are dropped. Sorting the
    neighbor lists makes every downstream traversal deterministic.
    """
    adj: dict[str, set[str]] = {nid: set() for nid in g.nodes}
    for e in g.edges:
        s, t = e["source"], e["target"]
        if s != t and s in adj and t in adj:
            adj[s].add(t)
            adj[t].add(s)
    return {nid: sorted(nbrs) for nid, nbrs in adj.items()}


def _node_view(g: SymbolGraph, nid: str) -> dict:
    return {"id": nid, **g.nodes[nid], "pointer": g.pointer(nid)}


def _pointer_line(g: SymbolGraph, nid: str) -> str:
    n = g.nodes[nid]
    return f"{g.pointer(nid)}  {n['name']} [{n['kind']}]"


# ---------------------------------------------------------------------------
# shortest path (undirected BFS)
# ---------------------------------------------------------------------------


def shortest_path(g: SymbolGraph, source: str, target: str,
                  adj: dict[str, list[str]] | None = None) -> dict:
    """Shortest path between two symbols over the undirected projection.

    *source* / *target* are resolved with the query layer's resolver (exact id,
    then exact/short name). Returns node-path pointers, or ``found: False`` with
    a reason. Ties are broken deterministically by sorted neighbor order.
    """
    a = resolve_node(g, source)
    b = resolve_node(g, target)
    if a is None:
        return {"found": False, "source": source, "target": target,
                "error": f"no symbol matching {source!r}"}
    if b is None:
        return {"found": False, "source": source, "target": target,
                "error": f"no symbol matching {target!r}"}
    if a == b:
        path = [a]
    else:
        if adj is None:
            adj = undirected_adj(g)
        prev: dict[str, str | None] = {a: None}
        frontier: deque[str] = deque([a])
        while frontier:
            cur = frontier.popleft()
            if cur == b:
                break
            for nb in adj.get(cur, ()):  # sorted → deterministic shortest path
                if nb not in prev:
                    prev[nb] = cur
                    frontier.append(nb)
        if b not in prev:
            return {"found": False, "source": source, "target": target,
                    "source_id": a, "target_id": b,
                    "error": "no path between symbols"}
        path = []
        node: str | None = b
        while node is not None:
            path.append(node)
            node = prev[node]
        path.reverse()
    return {
        "found": True,
        "source_id": a,
        "target_id": b,
        "length": len(path) - 1,
        "path": [_node_view(g, nid) for nid in path],
        "pointers": [_pointer_line(g, nid) for nid in path],
    }


# ---------------------------------------------------------------------------
# communities (label propagation)
# ---------------------------------------------------------------------------


def communities(g: SymbolGraph, min_size: int = 1, top: int | None = None) -> dict:
    """Detect communities by deterministic label propagation.

    Each node is seeded with the smallest id in its closed neighbourhood (itself
    plus its neighbours). This one-hop pre-consolidation is what stops a single
    bridge edge between two dense groups from flooding one global label across
    both in the first sweep — plain per-node-unique seeding degenerates badly on
    small symmetric graphs. Then, for a fixed number of sweeps in sorted node
    order, a node adopts the most frequent label among its neighbours (ties
    broken by the smallest label id). Convergence short-circuits the sweeps.
    Final labels are grouped into communities, numbered by
    ``(-size, smallest member id)`` so the numbering is reproducible.
    """
    adj = undirected_adj(g)
    order = sorted(g.nodes)
    labels: dict[str, str] = {}
    for nid in order:
        nbrs = adj.get(nid, ())
        labels[nid] = min([nid, *nbrs]) if nbrs else nid

    for _ in range(COMMUNITY_ITERATIONS):
        changed = False
        for nid in order:
            nbrs = adj.get(nid, ())
            if not nbrs:
                continue
            counts: dict[str, int] = {}
            for nb in nbrs:
                lb = labels[nb]
                counts[lb] = counts.get(lb, 0) + 1
            # most frequent label; tie-break by smallest label id (sorted)
            best = min(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
            if labels[nid] != best:
                labels[nid] = best
                changed = True
        if not changed:
            break

    groups: dict[str, list[str]] = defaultdict(list)
    for nid in order:  # preserves sorted member order within each community
        groups[labels[nid]].append(nid)
    clusters = sorted(groups.values(), key=lambda m: (-len(m), m[0]))

    node_community: dict[str, int] = {}
    out: list[dict] = []
    for cid, members in enumerate(clusters):
        for nid in members:
            node_community[nid] = cid
        if len(members) < min_size:
            continue
        out.append({
            "id": cid,
            "size": len(members),
            "members": [_node_view(g, nid) for nid in members],
        })
    if top is not None:
        out = out[:top]
    return {
        "count": len(out),
        "total_communities": len(clusters),
        "iterations": COMMUNITY_ITERATIONS,
        "node_community": node_community,
        "communities": out,
    }


# ---------------------------------------------------------------------------
# centrality (Brandes betweenness, degree fallback)
# ---------------------------------------------------------------------------


def _betweenness(g: SymbolGraph, adj: dict[str, list[str]]) -> dict[str, float]:
    """Brandes' betweenness centrality on the undirected, unweighted graph.

    Classic single-source-shortest-path accumulation, O(V*E). Sources are
    iterated in sorted order for determinism; the final scores are halved
    because each undirected shortest path is counted from both endpoints.
    """
    nodes = sorted(g.nodes)
    cb: dict[str, float] = {v: 0.0 for v in nodes}
    for s in nodes:
        stack: list[str] = []
        pred: dict[str, list[str]] = {v: [] for v in nodes}
        sigma: dict[str, float] = {v: 0.0 for v in nodes}
        dist: dict[str, int] = {v: -1 for v in nodes}
        sigma[s] = 1.0
        dist[s] = 0
        frontier: deque[str] = deque([s])
        while frontier:
            v = frontier.popleft()
            stack.append(v)
            for w in adj.get(v, ()):
                if dist[w] < 0:
                    dist[w] = dist[v] + 1
                    frontier.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    pred[w].append(v)
        delta: dict[str, float] = {v: 0.0 for v in nodes}
        while stack:
            w = stack.pop()
            for v in pred[w]:
                delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w])
            if w != s:
                cb[w] += delta[w]
    return {v: score / 2.0 for v, score in cb.items()}


def centrality(g: SymbolGraph, top: int = 10, method: str = "auto") -> dict:
    """Rank symbols by centrality.

    ``method='betweenness'`` runs Brandes; ``'degree'`` ranks by graph degree;
    ``'auto'`` (default) uses betweenness when the graph is small enough
    (<= BETWEENNESS_NODE_CAP nodes) and falls back to degree otherwise so a huge
    graph never triggers the O(V*E) computation.
    """
    n = len(g.nodes)
    if method == "auto":
        use = "betweenness" if n <= BETWEENNESS_NODE_CAP else "degree"
    else:
        use = method
    if use == "betweenness":
        scores = _betweenness(g, undirected_adj(g))
    elif use == "degree":
        scores = {nid: float(g.degree(nid)) for nid in g.nodes}
    else:
        raise ValueError(f"unknown centrality method: {method!r}")
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:max(0, top)]
    return {
        "method": use,
        "node_count": n,
        "central": [
            {"id": nid, "score": round(score, 4), "degree": g.degree(nid),
             **g.nodes[nid], "pointer": g.pointer(nid)}
            for nid, score in ranked
        ],
    }
