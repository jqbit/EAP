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
  - JS/TS and Go via bounded, non-backtracking regex extractors (functions,
    classes, imports). Minified/oversized lines are skipped to stay linear-time.
  - Binary and very large files are skipped.
- **Graph build** (`src/eap_context/graph.py`): nodes are symbols keyed by a
  qualified id; edges carry `EXTRACTED` (explicit / same-file) vs `INFERRED`
  (cross-file by name) provenance. Symlinks are not followed out of the root;
  the ignore list covers `.git`, `node_modules`, `.eap`, `dist`, `build`, etc.
- **Materialized cache**: node-link JSON at `<root>/.eap/graph.json`, written
  atomically. It is a cache, rebuilt when missing or malformed; cached node
  paths are validated to stay relative and within the root (no absolute or
  `..`-escaping pointers are trusted).
- **Query** (`src/eap_context/query.py`): substring/IDF seed scoring, bounded
  BFS to a depth with a **god-node degree cap** so a hub symbol is included but
  never expanded (it can't drag its callers into context). Returns a compact
  subgraph plus `file:line` **pointers** — never file contents.

## Public interface (MCP tools, `eap_graph_*`)

`eap_graph_build`, `eap_graph_query`, `eap_graph_neighbors`, `eap_graph_stats`,
`eap_graph_godnodes`, over JSON-RPC 2.0 stdio (`src/eap_context/mcp.py`), plus a
`cli.py` (`python3 -m eap_context build <dir>` / `query <text>`).

## Integration on the EAP spine

- Registered as an **MCP server** by the shared installer (the TLDR
  `tldr-shrink` registration is the precedent) — `python3 …/mcp.py <root>`.
- The `PreToolUse` hook nudges a graph query before a large raw file read.
- Retrieval routing: the front door sends **code-symbol** queries here and
  **blob/log/doc** queries to EAP-Runtime's FTS store. No duplication.

## Runtime & dependencies

Python 3 standard library only — **zero third-party dependencies**. The layer
is optional and independently installable; EAP-Voice and EAP-Runtime work
without it.

## Correctness & safety

Graph retrieval returns **pointers**, not summaries — the agent opens the real
`file:line`, so retrieval is lossless. If the graph is stale or missing, the
agent falls back to ordinary read/grep (the lossless escape hatch). The graph
never rewrites source. Extraction is bounded to linear time (no catastrophic
regex backtracking); out-of-tree symlinks are refused; a corrupt or poisoned
cache is rejected and rebuilt rather than trusted.
