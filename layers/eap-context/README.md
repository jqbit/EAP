# EAP-Context — symbol-graph engine (input membrane)

EAP-Context reduces the tokens flowing *into* context during retrieval. It
indexes a codebase into a local symbol graph, then answers queries with a
small subgraph plus `file:line` **pointers** — never file contents. The agent
opens the real `file:line` on demand, so retrieval stays lossless. If the
graph is stale or missing, ordinary read/grep remains the escape hatch.

**Zero dependencies.** The engine is Python standard library only (`ast`,
`re`, `json`, `os`, `math`, `bisect`, `hashlib`, `argparse`, `collections`).
No tree-sitter, no networkx, no numpy, no rapidfuzz, no jieba, no third-party
MCP package — no supply-chain surface.

Concept-derived from the MIT-licensed **graphify** project (design ideas:
AST → symbol graph, EXTRACTED/INFERRED edge provenance, god-node avoidance,
node-link JSON cache, MCP query surface). No graphify code or dependencies
are used. Lineage: `../../NOTICE` and `../../docs/legal/ATTRIBUTION.md`.

Ten languages via regex + Python via `ast`, deterministic graph algorithms
(shortest path, communities, centrality), typo-tolerant fuzzy seeding, and
incremental re-indexing are implemented; tree-sitter-grade parsing, any LLM
pass, non-code modalities, and graph-DB/visualisation export are deliberately
out of scope (see **Deliberate exclusions** below).

## Layout

```text
layers/eap-context/src/eap_context/
├── extract.py    # per-file symbol extraction (Python ast + 10 regex languages)
├── graph.py      # walk, adjacency graph, graph.json + incremental index.json cache
├── query.py      # IDF seed scoring, fuzzy fallback, bounded BFS, god-node cap
├── algorithms.py # shortest path, communities, centrality (undirected projection)
├── mcp.py        # JSON-RPC 2.0 over stdio (MCP), pure dispatch
├── cli.py        # build[--update] / query / stats / godnodes / neighbors /
│                 #   path / communities / central / serve
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
| `.rs` | `fn name`, `struct`/`enum`/`trait Name` (with `pub`/`async`/`unsafe`/`const` modifiers), `use a::b::c` (module segment kept). |
| `.java` | `class`/`interface`/`enum`/`record Name`, modifier-qualified methods and constructors, `import a.b.C` (incl. `import static`). |
| `.c` `.h` `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` | Column-0 `type name(` function definitions/prototypes (control-flow keywords rejected; C++ `Class::method` kept), `class`/`struct Name`, `#include <...>`/`"..."`. |
| `.cs` | `class`/`interface`/`struct`/`enum`/`record Name`, modifier-qualified methods, `using A.B.C` (incl. `using static`). |
| `.rb` | `def name` / `def self.name`, `class Name < Base`, `module Name`, `require`/`require_relative '...'`. |
| `.php` | `function name(` (visibility-qualified), `class`/`interface`/`trait Name extends Base`, `use App\Ns\Class`. |

Every regex extractor is `^`-anchored per line, confines whitespace to `[ \t]`
(never `\s`), captures single bounded tokens, and runs after minified/oversized
lines are neutralized, so extraction stays **linear-time** on adversarial input
(one ReDoS regression test per language). Files larger than 1 MB and files with
a NUL byte in the first 8 KB (binary) are skipped. Unparseable Python returns no
symbols rather than failing the build.

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
- **Incremental index**: a per-file fingerprint cache at `<root>/.eap/index.json`
  keyed by `(size, mtime_ns, sha256)` with each file's extracted symbols.
  `build(root, incremental=True)` (CLI `build --update`, MCP `incremental: true`)
  re-extracts only files whose size/mtime changed and reuses the rest; the result
  is identical to a full build. The fingerprint cache is validated as untrusted
  input (same rules as the graph cache) and dropped-then-rebuilt if unsafe.

## Query

1. **Seed scoring** — query tokens (camelCase/snake_case split) scored
   against node name + filename tokens: exact-token IDF, half-credit
   substring match, 0.4-credit prefix overlap (`pointers` ~ `pointer`);
   definitions get a 1.2x boost over modules/imports.
2. **Fuzzy fallback** — when exact/substring/prefix scoring yields fewer than
   5 seeds, a typo-tolerant pass recovers more: a trigram inverted index over
   symbol names prunes candidates, then a stdlib bounded (≤2) Levenshtein keeps
   those within the edit budget (`confgure` → `configure_widget`). Fires only as
   a fallback, so exact-match ranking is unaffected.
3. **Bounded BFS** — from the top 5 seeds, out to `depth` (default 3), up to
   `limit` nodes (default 20).
4. **God-node cap** — nodes whose degree exceeds the cap are *included* in
   results but never *expanded*, so one hub utility cannot drag its hundreds
   of callers into context. Default cap: `max(10, mean_degree + 2·stdev)`
   computed per graph; overridable per query.
5. **Output** — compact subgraph (`nodes`, `edges`) plus
   `pointers: ["path/file.py:42  name [kind]", ...]`. Never source text.

## Graph algorithms

Deterministic, stdlib-only, over the **undirected projection** of the adjacency
lists (`algorithms.py`). All return pointers/ids, never file contents.

- **`shortest_path(a, b)`** — BFS between two symbols (resolved by id or name);
  returns the node path as pointers, or `found: false`.
- **`communities()`** — label-propagation community detection: fixed sweep count,
  min-neighbourhood label seeding (so a single bridge edge doesn't flood one
  label across two groups), sorted-id tie-break. Fully reproducible.
- **`centrality()`** — Brandes betweenness centrality; a node-count guard falls
  back to O(V+E) degree centrality on graphs too large for the O(V·E) computation
  (`method: auto|betweenness|degree`).

## MCP surface

`mcp.py` speaks newline-delimited JSON-RPC 2.0 on stdio. It answers MCP
`initialize` / `tools/list` / `tools/call`, and also accepts the tool names
as direct JSON-RPC methods. Dispatch (`handle_request` / `dispatch`) is a
pure function — testable without the stdio loop.

| Tool | Does |
|---|---|
| `eap_graph_build` | (re)index a directory into `.eap/graph.json` (`incremental: true` for `--update` semantics) |
| `eap_graph_query` | subgraph + `file:line` pointers for a text query |
| `eap_graph_neighbors` | edges around one symbol (by id or name) |
| `eap_graph_stats` | node/edge/file counts, kind histogram, hub threshold |
| `eap_graph_godnodes` | most-connected symbols |
| `eap_graph_path` | shortest path between two symbols, as pointers |
| `eap_graph_communities` | label-propagation community clusters |
| `eap_graph_central` | betweenness/degree centrality ranking |

## CLI

```bash
export PYTHONPATH=layers/eap-context/src

python3 -m eap_context build <dir> [--update]   # --update = incremental re-index
python3 -m eap_context query "god node cap" --root <dir> [--depth 3] [--limit 20] [--json]
python3 -m eap_context stats --root <dir>
python3 -m eap_context godnodes --root <dir>
python3 -m eap_context neighbors SymbolGraph --root <dir>
python3 -m eap_context path <symbolA> <symbolB> --root <dir> [--json]
python3 -m eap_context communities --root <dir> [--min-size N] [--top N] [--json]
python3 -m eap_context central --root <dir> [--top N] [--method auto|betweenness|degree]
python3 -m eap_context serve --root <dir>     # MCP stdio server
```

## Tests

```bash
python3 tests/test_context_engine.py
python3 -m unittest tests.test_context_engine
```

Covers: extraction for Python + all ten regex languages (names, kinds, refs,
line numbers, and a ReDoS/linearity regression per language), ignore list and
binary skip, same-file vs cross-file edge provenance, pointer-only query output,
god-node capping (capped vs uncapped fan-out), JSON cache round-trip and
poisoned/corrupt-cache rejection, incremental re-index (only-changed-files reuse,
graph identical to a full build, poisoned/corrupt fingerprint-cache rejection),
graph algorithms (shortest path / communities / centrality on a known fixture),
fuzzy typo seeding, and MCP dispatch for all 8 tools (direct method, `tools/call`,
`-32601` unknown method, `-32602` bad params, notification silence, subprocess
script launch).

## Deliberate exclusions

Conscious non-goals that keep the layer a zero-dependency, deterministic
code-symbol membrane (see `DESIGN.md` for the rationale):

- **No tree-sitter / real parsers** — regex + `ast` only, so coverage is
  deliberately shallower than graphify's ~40 tree-sitter grammars, in exchange
  for zero native deps and linear-time extraction.
- **No LLM / semantic pass** — no embeddings or model-scored relevance; seeds are
  IDF/substring/fuzzy string matches. No network, no API key, fully reproducible.
- **No non-code modalities** — no PDF/image/audio/video ingestion.
- **No visualisation / graph-DB export** — no HTML/D3 viewer, no Neo4j or
  GraphML/Gephi export; the public surface is pointers and subgraphs.
- **Fuzzy is a narrow fallback**, not a search engine — bounded (≤2) Levenshtein
  over trigram-pruned candidates, only when exact seeding is thin. No rapidfuzz.
