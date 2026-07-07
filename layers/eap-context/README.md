# EAP-Context — symbol-graph engine (input membrane)

EAP-Context reduces the tokens flowing *into* context during retrieval. It
indexes a codebase into a local symbol graph, then answers queries with a
small subgraph plus `file:line` **pointers** — never file contents. The agent
opens the real `file:line` on demand, so retrieval stays lossless. If the
graph is stale or missing, ordinary read/grep remains the escape hatch.

**Zero dependencies.** The engine is Python standard library only (`ast`,
`re`, `json`, `os`, `math`, `argparse`). No tree-sitter, no networkx, no
numpy, no third-party MCP package — no supply-chain surface.

Concept-derived from the MIT-licensed **graphify** project (design ideas:
AST → symbol graph, EXTRACTED/INFERRED edge provenance, god-node avoidance,
node-link JSON cache, MCP query surface). No graphify code or dependencies
are used. Lineage: `../../NOTICE` and `../../docs/legal/ATTRIBUTION.md`.

## Layout

```text
layers/eap-context/src/eap_context/
├── extract.py    # per-file symbol extraction
├── graph.py      # directory walk, adjacency-list graph, .eap/graph.json cache
├── query.py      # IDF seed scoring, bounded BFS, god-node cap, pointers
├── mcp.py        # JSON-RPC 2.0 over stdio (MCP), pure dispatch
├── cli.py        # build / query / stats / godnodes / neighbors / serve
└── __main__.py   # python3 -m eap_context
```

Tests: `tests/test_context_engine.py` (repo root).

## Extraction

Each symbol is `{name, kind, file, line, refs}` with kind
`function | class | method | import` (plus one `module` node per file added
at graph-build time).

| Language | Method |
|---|---|
| `.py` | `ast` — walks `FunctionDef`/`AsyncFunctionDef`/`ClassDef`/`Import`/`ImportFrom`; refs are `Call` names + decorators + class bases, collected without descending into nested definitions (those become their own symbols with qualified names like `Store.save`). Descends into top-level `if`/`try`/`with` blocks (e.g. `TYPE_CHECKING`). |
| `.js` `.mjs` `.jsx` `.ts` `.tsx` | Conservative line-anchored regexes: `function name(`, `const name = (...) =>`, `const name = function`, `class Name extends Base`, `import ... from '...'`, `require('...')`. Refs come from `ident(` matches in the text slice between one definition and the next, keyword-filtered. |
| `.go` | Regexes for `func Name(` (incl. method receivers), `type Name struct|interface`, single and block imports. Same slice-based ref collection. |

Files larger than 1 MB and files with a NUL byte in the first 8 KB (binary)
are skipped. Unparseable Python returns no symbols rather than failing the
build.

## Graph

- **Nodes** keyed by qualified id `relpath::qualname` (modules by `relpath`);
  id collisions are disambiguated with `@line`.
- **Edges** `{source, target, relation, provenance}` with relations
  `defines | calls | references | imports` and provenance:
  - `EXTRACTED` — explicit in source and resolved within the same file (or a
    structural `defines` edge).
  - `INFERRED` — explicit reference resolved to a *different* file purely by
    name matching.
- Ref names matching more than 8 definitions (think `get`, `run`) are not
  linked across files — too ambiguous.
- Ignored directories: `.git`, `node_modules`, `.eap`, `dist`, `build`,
  `__pycache__`, venvs, caches, `vendor`, `target`, and any dot-directory.
- **Cache**: node-link JSON at `<root>/.eap/graph.json` (atomic write via
  temp file + rename). It is a cache, not a second source of truth —
  `load_or_build` rebuilds on a missing or corrupt file.

## Query

1. **Seed scoring** — query tokens (camelCase/snake_case split) scored
   against node name + filename tokens: exact-token IDF, half-credit
   substring match, 0.4-credit prefix overlap (`pointers` ~ `pointer`);
   definitions get a 1.2x boost over modules/imports.
2. **Bounded BFS** — from the top 5 seeds, out to `depth` (default 3), up to
   `limit` nodes (default 20).
3. **God-node cap** — nodes whose degree exceeds the cap are *included* in
   results but never *expanded*, so one hub utility cannot drag its hundreds
   of callers into context. Default cap: `max(10, mean_degree + 2·stdev)`
   computed per graph; overridable per query.
4. **Output** — compact subgraph (`nodes`, `edges`) plus
   `pointers: ["path/file.py:42  name [kind]", ...]`. Never source text.

## MCP surface

`mcp.py` speaks newline-delimited JSON-RPC 2.0 on stdio. It answers MCP
`initialize` / `tools/list` / `tools/call`, and also accepts the tool names
as direct JSON-RPC methods. Dispatch (`handle_request` / `dispatch`) is a
pure function — testable without the stdio loop.

| Tool | Does |
|---|---|
| `eap_graph_build` | (re)index a directory into `.eap/graph.json` |
| `eap_graph_query` | subgraph + `file:line` pointers for a text query |
| `eap_graph_neighbors` | edges around one symbol (by id or name) |
| `eap_graph_stats` | node/edge/file counts, kind histogram, hub threshold |
| `eap_graph_godnodes` | most-connected symbols |

## CLI

```bash
export PYTHONPATH=layers/eap-context/src

python3 -m eap_context build <dir>
python3 -m eap_context query "god node cap" --root <dir> [--depth 3] [--limit 20] [--json]
python3 -m eap_context stats --root <dir>
python3 -m eap_context godnodes --root <dir>
python3 -m eap_context neighbors SymbolGraph --root <dir>
python3 -m eap_context serve --root <dir>     # MCP stdio server
```

## Tests

```bash
python3 tests/test_context_engine.py
python3 -m unittest tests.test_context_engine
```

Covers: Python + JS extraction (names, kinds, refs, line numbers), ignore
list and binary skip, same-file vs cross-file edge provenance, pointer-only
query output, god-node capping (capped vs uncapped fan-out), JSON cache
round-trip, and MCP dispatch (direct method, `tools/call`, `-32601` unknown
method, `-32602` bad params, notification silence).
