# EAP-Context — design (as built)

EAP-Context is the **input membrane**: it reduces the tokens that flow *into*
context during retrieval. Instead of loading whole files, the agent queries a
local code-symbol graph and receives a small subgraph plus `file:line` pointers
it opens on demand.

> This is a description of the **shipped** engine. For the exact tool list and
> usage see `README.md` in this directory.

## Provenance

EAP-Context is an **independent, Python-standard-library-only** implementation,
**concept-derived** from the MIT-licensed
[graphify](https://github.com/Graphify-Labs/graphify) project. It uses **no
graphify source code** and **none of graphify's dependencies** (no tree-sitter,
networkx, numpy, rapidfuzz, or `mcp` package). Building a lean stdlib engine
instead of vendoring graphify's ~20-package dependency tree is a deliberate
hard-freeze choice: it keeps EAP's supply-chain surface at zero. See
`../../docs/legal/ATTRIBUTION.md`.

## The engine (what ships)

- **Symbol extraction** (`src/eap_context/extract.py`):
  - Python via the stdlib `ast` module (FunctionDef / AsyncFunctionDef /
    ClassDef / Import / ImportFrom; refs = call names, decorators, class bases).
  - JS/TS, Go, **Rust, Java, C, C++, C#, Ruby, and PHP** via bounded,
    non-backtracking regex extractors (functions, classes/structs/traits,
    imports/uses/includes, and intra-file refs). Every regex is `^`-anchored per
    line, uses `[ \t]` never `\s` (so it can't cross newlines), captures single
    bounded tokens with no two adjacent unbounded quantifiers, and runs after
    minified/oversized lines are neutralized — so extraction is **provably
    linear-time** on adversarial input (each new language has a ReDoS regression
    test). Python stays on `ast`.
  - Binary and very large files are skipped.
- **Graph build** (`src/eap_context/graph.py`): nodes are symbols keyed by a
  qualified id; edges carry `EXTRACTED` (explicit / same-file) vs `INFERRED`
  (cross-file by name) provenance. Symlinks are not followed out of the root;
  the ignore list covers `.git`, `node_modules`, `.eap`, `dist`, `build`, etc.
- **Materialized cache**: node-link JSON at `<root>/.eap/graph.json`, written
  atomically. It is a cache, rebuilt when missing or malformed; cached node
  paths are validated to stay relative and within the root (no absolute or
  `..`-escaping pointers are trusted).
- **Incremental indexing**: a per-file fingerprint cache at
  `<root>/.eap/index.json` keys each source file by `(size, mtime_ns, sha256)`
  and stores its extracted symbols. `build(root, incremental=True)` (CLI
  `build --update`, MCP `incremental: true`) re-extracts only files whose
  `(size, mtime_ns)` changed and reuses cached symbols for the rest; the resolve
  pass is always redone in full, so the result is byte-identical to a from-scratch
  build. The fingerprint cache is untrusted input too: it is validated exactly
  like the graph cache (in-tree relpaths, positive-int lines, control-char
  rejection, per-symbol integrity) and dropped wholesale — degrading to a full
  extraction, never a crash or a forged pointer — if anything is off.
- **Query** (`src/eap_context/query.py`): substring/IDF seed scoring, bounded
  BFS to a depth with a **god-node degree cap** so a hub symbol is included but
  never expanded (it can't drag its callers into context). Returns a compact
  subgraph plus `file:line` **pointers** — never file contents. A **fuzzy
  fallback** (a stdlib bounded Levenshtein over a trigram inverted index) recovers
  seeds for misspelled query terms, but only when exact/substring/prefix scoring
  yields too few — exact-match ranking is otherwise unchanged.
- **Graph algorithms** (`src/eap_context/algorithms.py`), stdlib, deterministic,
  over the undirected projection of the existing adjacency lists:
  - `shortest_path(a, b)` — BFS; returns the node path as pointers.
  - `communities()` — label-propagation community detection (fixed sweep count,
    min-neighbourhood seeding, sorted-id tie-break — fully reproducible).
  - `centrality()` — Brandes betweenness, with a node-count guard that falls back
    to degree centrality on graphs too large for the O(V·E) computation.

## Public interface (MCP tools, `eap_graph_*`)

`eap_graph_build`, `eap_graph_query`, `eap_graph_neighbors`, `eap_graph_stats`,
`eap_graph_godnodes`, `eap_graph_path`, `eap_graph_communities`,
`eap_graph_central` (8 tools), over JSON-RPC 2.0 stdio (`src/eap_context/mcp.py`),
plus a `cli.py` (`build [--update]` / `query` / `stats` / `godnodes` /
`neighbors` / `path` / `communities` / `central` / `serve`).

## Integration on the EAP spine

- Registered as an **MCP server** by the shared installer (the TLDR
  `tldr-shrink` registration is the precedent) — `python3 …/mcp.py <root>`.
- The `PreToolUse` hook nudges a graph query before a large raw file read.
- Retrieval routing: the front door sends **code-symbol** queries here and
  **blob/log/doc** queries to EAP-Runtime's FTS store. No duplication.

## Runtime & dependencies

Python 3 standard library only — **zero third-party dependencies** (`ast`, `re`,
`json`, `os`, `math`, `bisect`, `hashlib`, `argparse`, `collections`). No
tree-sitter, networkx, numpy, rapidfuzz, jieba, or third-party MCP package. The
layer is optional and independently installable; EAP-Signal and EAP-Runtime work
without it.

## Deliberate exclusions (out of scope)

These are conscious non-goals, not TODOs. EAP-Context is a zero-dependency,
deterministic **code-symbol membrane**; the following would each pull in exactly
the supply-chain, non-determinism, or scope creep the hard-freeze forbids:

- **No tree-sitter / real parsers.** Extraction is `ast` (Python) + conservative
  regex (everything else). That is deliberately *shallower* than graphify's
  tree-sitter grammars (~40 languages, exact parse trees): the regex extractors
  cover common function/class/import/reference forms, skip ambiguous or unusual
  constructs, and prefer false negatives over false positives. The payoff is zero
  native dependencies and provably linear-time extraction.
- **No LLM / semantic pass.** No embeddings, no model-scored relevance, no
  natural-language summarisation. Seeds are IDF/substring/fuzzy string matches;
  results are pointers the agent opens itself. The engine is fully reproducible
  and runs with no network and no API key.
- **No non-code modalities.** No PDF, image, audio, or video ingestion — only
  source files with recognised extensions.
- **No visualisation / graph-DB export.** No HTML/D3 graph viewer, no Neo4j or
  other graph-database backend, no GraphML/Gephi export. The only persisted form
  is the internal node-link JSON cache; the public surface is pointers and
  subgraphs over MCP/CLI.
- **Fuzzy matching is a narrow fallback,** not a fuzzy search engine: a bounded
  (≤2) Levenshtein over a trigram-pruned candidate set, used only when exact
  seeding is too thin. No rapidfuzz, no learned ranking.

## Correctness & safety

Graph retrieval returns **pointers**, not summaries — the agent opens the real
`file:line`, so retrieval is lossless. If the graph is stale or missing, the
agent falls back to ordinary read/grep (the lossless escape hatch). The graph
never rewrites source. Extraction across **all** languages (the ten regex
extractors plus Python's `ast`) is bounded to linear time — no catastrophic
regex backtracking, with a ReDoS regression test per language — because every
pattern is per-line-anchored, whitespace-confined to `[ \t]`, and length-guarded.
Out-of-tree symlinks are refused. Both untrusted caches — the graph cache
(`.eap/graph.json`) and the incremental fingerprint cache (`.eap/index.json`) —
are validated (in-tree relpaths, positive-int lines, control-char rejection,
referential/consistency integrity) and rejected-then-rebuilt rather than trusted;
a deeply nested payload that would `RecursionError` is caught the same way. The
graph algorithms and fuzzy fallback add no dependencies and no non-determinism.
