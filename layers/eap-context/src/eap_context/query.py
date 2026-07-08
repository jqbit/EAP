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
from collections import defaultdict, deque

from .graph import SymbolGraph

DEFAULT_DEPTH = 3
DEFAULT_LIMIT = 20
MAX_SEEDS = 5

# Fuzzy (typo-tolerant) seeding kicks in only as a FALLBACK: when exact / sub-
# string / prefix scoring finds fewer than this many candidate seeds, a bounded
# Levenshtein pass over trigram-pruned candidates recovers misspelled terms.
FUZZY_MIN_SEEDS = MAX_SEEDS
FUZZY_MIN_TOKEN = 4        # short tokens are too collision-prone to fuzzy-match
FUZZY_MAX_DIST_SHORT = 1   # edit budget for tokens under 6 chars
FUZZY_MAX_DIST_LONG = 2    # edit budget for tokens 6+ chars

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")

# Natural-language filler dropped from a QUERY before scoring (C6): they carry
# no code signal and otherwise substring-match noise ("work" -> "worker"). Only
# ever filtered from the query; NODE tokens are never filtered, so a symbol
# literally named "work"/"do"/"is" stays findable.
QUERY_STOPWORDS = frozenset({
    "how", "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "does", "do", "did", "of", "to", "for", "what", "where", "why", "when",
    "which", "who", "and", "or", "in", "on", "at", "with", "that", "this",
    "it", "its", "as", "by", "from", "work", "works", "working",
})


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens; camelCase and snake_case both split."""
    return _TOKEN_RE.findall(_CAMEL_RE.sub(" ", text).lower())


def _node_tokens(g: SymbolGraph, nid: str) -> set[str]:
    cache = g._node_tokens_cache
    toks = cache.get(nid)
    if toks is None:
        n = g.nodes[nid]
        toks = set(tokenize(n["name"])) | set(tokenize(n["file"].rsplit("/", 1)[-1]))
        cache[nid] = toks
    return toks


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
    # Exclude the synthetic per-file `module` nodes (C2): a module accrues a
    # `defines` edge to every symbol it holds, so a big file's module node has a
    # high raw degree that is structural noise, not a real hub.
    hubs = sorted(
        ((g.degree(nid), nid) for nid in g.nodes
         if g.degree(nid) >= thr and g.nodes[nid]["kind"] != "module"),
        reverse=True,
    )[:top]
    return [
        {"id": nid, "degree": deg, "pointer": g.pointer(nid), **g.nodes[nid]}
        for deg, nid in hubs
    ]


# ---------------------------------------------------------------------------
# fuzzy (typo-tolerant) matching — stdlib trigram index + bounded Levenshtein
# ---------------------------------------------------------------------------


def _trigrams(s: str) -> set[str]:
    """Character trigrams of *s* (a whole-string fallback for len < 3)."""
    s = s.lower()
    if len(s) < 3:
        return {s} if s else set()
    return {s[i:i + 3] for i in range(len(s) - 2)}


def build_trigram_index(g: SymbolGraph) -> dict[str, list[str]]:
    """Inverted index: trigram -> node ids whose short name contains it.

    Used to prune fuzzy-match candidates on large graphs so bounded Levenshtein
    only runs against names that already share a 3-gram with the query token,
    instead of every node. Built lazily (only when the fuzzy fallback fires) and
    memoized on the graph (C1) so repeated fuzzy queries share the one index.
    """
    if g._trigram_index is not None:
        return g._trigram_index
    idx: dict[str, list[str]] = defaultdict(list)
    for nid, n in g.nodes.items():
        short = n["name"].rsplit(".", 1)[-1].lower()
        for tg in _trigrams(short):
            idx[tg].append(nid)
    g._trigram_index = idx
    return idx


def _bounded_levenshtein(a: str, b: str, max_dist: int) -> int:
    """Levenshtein distance, capped: returns ``max_dist + 1`` once it is exceeded.

    Classic DP with an early-exit when the whole working row is already over
    budget, so cost is O(len(a) * len(b)) worst case but usually far less. Only
    ever called on trigram-pruned candidate pairs, so total work stays bounded.
    """
    la, lb = len(a), len(b)
    if abs(la - lb) > max_dist:
        return max_dist + 1
    if la > lb:  # keep the inner row short
        a, b, la, lb = b, a, lb, la
    prev = list(range(la + 1))
    for j in range(1, lb + 1):
        cur = [j] + [0] * la
        bj = b[j - 1]
        row_min = cur[0]
        for i in range(1, la + 1):
            cost = 0 if a[i - 1] == bj else 1
            cur[i] = min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + cost)
            if cur[i] < row_min:
                row_min = cur[i]
        if row_min > max_dist:
            return max_dist + 1
        prev = cur
    return prev[la]


def _fuzzy_scores(
    g: SymbolGraph,
    q_tokens: list[str],
    idf: dict[str, float],
    node_tokens: dict[str, set[str]],
    already: set[str],
) -> list[tuple[float, str]]:
    """Recover seeds for misspelled query tokens via bounded edit distance.

    For each query token >= FUZZY_MIN_TOKEN chars, gather nodes sharing at least
    one trigram, then keep those whose name has a token within the edit budget
    (1 for short tokens, 2 for long). Awards reduced IDF credit (distance-1 more
    than distance-2). Nodes already scored exactly are skipped.
    """
    tokens = [t for t in q_tokens if len(t) >= FUZZY_MIN_TOKEN]
    if not tokens:
        return []
    tindex = build_trigram_index(g)
    accum: dict[str, float] = {}
    for t in tokens:
        max_dist = FUZZY_MAX_DIST_SHORT if len(t) < 6 else FUZZY_MAX_DIST_LONG
        candidates: set[str] = set()
        for tg in _trigrams(t):
            candidates.update(tindex.get(tg, ()))
        for nid in candidates:
            if nid in already:
                continue
            best = None
            for tok in node_tokens[nid]:
                if abs(len(tok) - len(t)) > max_dist:
                    continue
                d = _bounded_levenshtein(t, tok, max_dist)
                if d <= max_dist and (best is None or d < best):
                    best = d
            if best is not None:
                credit = (0.35 if best == 1 else 0.2) * idf.get(t, 1.0)
                accum[nid] = accum.get(nid, 0.0) + credit
    out: list[tuple[float, str]] = []
    for nid, score in accum.items():
        if g.nodes[nid]["kind"] in ("function", "method", "class"):
            score *= 1.2
        out.append((score, nid))
    return out


# ---------------------------------------------------------------------------
# seed scoring
# ---------------------------------------------------------------------------


def _seed_scores_detailed(
    g: SymbolGraph, text: str,
) -> tuple[list[tuple[float, str]], dict[str, tuple]]:
    """Score nodes against the query; also record the best node per query token.

    Returns ``(scored, token_best)`` where ``scored`` is the sorted (score, nid)
    list and ``token_best`` maps each query token that matched something to
    ``(rank_key, nid)`` — its single best-matching node ranked by contribution
    then node degree. ``token_best`` drives per-token seed coverage in query().
    """
    q_tokens_all = [t for t in dict.fromkeys(tokenize(text)) if t]
    if not q_tokens_all or not g.nodes:
        return [], {}
    # C6: drop query-side stopwords before scoring; if the query is ALL
    # stopwords, keep it unfiltered so a symbol literally named a stopword is
    # still reachable. Node tokens are never filtered.
    q_tokens = [t for t in q_tokens_all if t not in QUERY_STOPWORDS] or q_tokens_all

    node_tokens = {nid: _node_tokens(g, nid) for nid in g.nodes}
    total = len(g.nodes)

    idf: dict[str, float] = {}
    for t in q_tokens:
        # C1: IDF is a pure function of graph state, so memoize per token and
        # only compute the terms not already cached on this graph.
        v = g._idf_cache.get(t)
        if v is None:
            df = sum(1 for toks in node_tokens.values() if t in toks)
            v = math.log((total + 1) / (df + 1)) + 1.0
            g._idf_cache[t] = v
        idf[t] = v

    scored: list[tuple[float, str]] = []
    token_best: dict[str, tuple] = {}
    for nid, toks in node_tokens.items():
        name_lc = g.nodes[nid]["name"].lower()
        score = 0.0
        for t in q_tokens:
            contrib = 0.0
            if t in toks:
                contrib = idf[t]
            elif len(t) >= 3 and t in name_lc:
                contrib = 0.5 * idf[t]
            elif len(t) >= 4 and any(
                (tok.startswith(t) or t.startswith(tok))
                and min(len(t), len(tok)) >= 4
                for tok in toks
            ):
                # prefix overlap: "pointers" ~ "pointer", "handler" ~ "handlers"
                contrib = 0.4 * idf[t]
            if contrib > 0:
                score += contrib
                key = (contrib, g.degree(nid))
                if t not in token_best or key > token_best[t][0]:
                    token_best[t] = (key, nid)
        if score > 0:
            # light preference for definitions over imports/modules
            if g.nodes[nid]["kind"] in ("function", "method", "class"):
                score *= 1.2
            scored.append((score, nid))

    if len(scored) < FUZZY_MIN_SEEDS:
        already = {nid for _, nid in scored}
        scored += _fuzzy_scores(g, q_tokens, idf, node_tokens, already)

    scored.sort(key=lambda p: (-p[0], p[1]))
    return scored, token_best


def seed_scores(g: SymbolGraph, text: str) -> list[tuple[float, str]]:
    """Score every node against the query: exact-token IDF + substring credit.

    When exact/substring/prefix scoring yields fewer than FUZZY_MIN_SEEDS
    candidates, a typo-tolerant fuzzy pass (trigram-pruned bounded Levenshtein)
    is appended so a misspelled term still seeds the traversal. Fuzzy is only a
    fallback: on any query that already matches enough symbols it never runs, so
    exact-match ranking is unchanged.
    """
    return _seed_scores_detailed(g, text)[0]


def _select_seeds(scored: list[tuple[float, str]], token_best: dict[str, tuple]) -> list[str]:
    """Pick BFS seeds (C3): the top node, everything within 20% of the top
    score (capped at MAX_SEEDS), then a guaranteed best node for every query
    token that matched — so a term that only substring-matches is never dropped.
    """
    if not scored:
        return []
    cutoff = scored[0][0] * 0.2
    seeds: list[str] = []
    seen: set[str] = set()
    for score, nid in scored:  # sorted by score desc
        if seeds and score < cutoff:
            break
        if len(seeds) >= MAX_SEEDS:
            break
        if nid not in seen:
            seen.add(nid)
            seeds.append(nid)
    # every query token that scored > 0 contributes at least one of its best
    # nodes, even if the score threshold / cap left it out.
    for _t, (_key, nid) in token_best.items():
        if nid not in seen:
            seen.add(nid)
            seeds.append(nid)
    return seeds


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
    scored, token_best = _seed_scores_detailed(g, text)
    seeds = _select_seeds(scored, token_best)
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
