# EAP-Context — symbol-graph engine (input membrane)

EAP-Context reduces the tokens flowing *into* context during retrieval. It
indexes a codebase into a local symbol graph, then answers queries with a
small subgraph plus `file:line` **pointers** — never file contents. The agent
opens the real `file:line` on demand, so retrieval stays lossless. If the
graph is stale or missing, ordinary read/grep remains the escape hatch.

**Zero dependencies.** Python standard library only. No tree-sitter, networkx,
numpy, rapidfuzz, watchdog, or third-party MCP package.

Concept-derived from the MIT-licensed **graphify** project (design ideas only).
No graphify code or dependencies are used. Lineage: `../../NOTICE` and
`../../docs/legal/ATTRIBUTION.md`.

## Layout

```text
layers/eap-context/src/eap_context/
├── extract.py    # per-file extraction (ast + many regex languages + SFC/md/…)
├── manifest.py   # package.json / pyproject / go.mod / Cargo.toml / requirements
├── graph.py      # walk, adjacency graph, graph.json + index + communities
├── ignore.py     # nested .gitignore + .eapignore (directory-scoped)
├── query.py      # IDF seeds, BFS/DFS, token_budget, get_node/explain/community
├── algorithms.py # shortest path, communities, centrality, affected
├── export.py     # GraphML + HTML/SVG; merge-graphs; optional ~/.eap/global
├── hooks.py      # git post-commit/post-checkout auto-rebuild
├── prs.py        # gh PRs, worktrees, structural triage + overlap hints
├── reflect.py    # querylog + preferred/contested + .eap/LESSONS.md
├── mcp.py        # JSON-RPC 2.0 (16 tools); stdio + keyed HTTP
├── cli.py        # build/query/…/explain/export/merge-graphs/watch/serve
└── __main__.py
```

Tests: `tests/test_context_engine.py` (repo root / `EAP/tests`).

## Extraction

Each symbol is `{name, kind, file, line, refs[, inherits][, implements]}`.

| Language / format | Method |
|---|---|
| `.py` | `ast` — defs, imports, calls, decorator/base refs; bases → `inherits` |
| `.js` `.mjs` `.jsx` `.ts` `.tsx` | function / arrow / class extends / import / require |
| `.go` | `func`, `type … struct\|interface`, import lines/blocks |
| `.rs` | `fn` / `struct`/`enum`/`trait`, `use` |
| `.java` | class/interface/enum/record (+ extends/implements), methods, import |
| `.c` `.h` `.cpp` … | column-0 functions, class/struct, `#include` |
| `.cs` | class/… (+ `: bases`), methods, `using` |
| `.rb` | `def`, `class < Base`, `module`, `require` |
| `.php` | `function`, `class\|interface\|trait extends`, `use` |
| `.kt` `.kts` | `fun`, `class\|interface\|object : Bases`, `import` |
| `.scala` | `def`, `class\|object\|trait extends/with`, `import` |
| `.swift` | `func`, `class\|struct\|enum\|protocol : Bases`, `import` |
| `.lua` | `function` / `name = function`, `require` |
| `.zig` | `fn`, `const Name = struct\|enum…`, `@import` |
| `.sh` `.bash` | `name()` / `function name`, `source`/`.` |
| `.ex` `.exs` | `def`/`defp`, `defmodule`, alias/import/require/use |
| `.jl` | `function`/`macro`, `struct`/`module` (`<:` → inherits), using/import |
| `.dart` | class extends/implements, braced functions, `import` |
| `.tf` `.hcl` | `resource`/`data`/`module`/… block labels |
| `.sql` | `CREATE TABLE\|VIEW\|…` names |
| `.ps1` `.psm1` | `function`/`filter`, `class`, Import-Module |
| `.vue` `.svelte` | `<script>` blocks → JS extractor |
| `.json` | shallow top-level keys |
| `.md` `.markdown` | ATX headings as nodes |
| `.yaml` `.yml` | indent-0 keys |

Every regex extractor is linear-time on adversarial input (ReDoS tests). Files
> 1 MB or with a NUL in the first 8 KB are skipped.

### Manifests → `depends_on`

Also indexed (not via `CODE_EXTENSIONS`): `package.json`, `pyproject.toml`,
`go.mod`, `Cargo.toml`, `requirements.txt` → `dependency` nodes + `depends_on`
edges from the manifest module.

## Graph

- Nodes: `relpath::qualname` (+ module nodes; optional `community` int).
- Edges: `defines | calls | references | imports | inherits | implements |
  depends_on` with `EXTRACTED` / `INFERRED` provenance.
- Ignore: hardcoded defaults + **nested** `.gitignore` / `.eapignore`.
- Cache: `.eap/graph.json`, `.eap/index.json`, `.eap/communities.json`.

## Query

IDF/substring/prefix seeding → optional fuzzy fallback → bounded **BFS or
DFS** with god-node cap → optional **token_budget** pack → pointers.

Helpers: `get_node`, `explain` (structural why / callers / callees),
`get_community`.

## Algorithms / workflow

- shortest_path, communities (label-propagation; ids stamped at build),
  centrality, affected blast radius
- `hook install|uninstall`, `prs` / `triage_prs` (blast rank + overlap hints +
  worktree map), reflect tags → `.eap/LESSONS.md`
- `export` graphml|html|svg; `merge-graphs` (+ optional `~/.eap/global`);
  `watch` (mtime polling)

## MCP tools (16)

| Tool | Does |
|---|---|
| `eap_graph_build` | (re)index; `incremental: true` = `--update` |
| `eap_graph_query` | subgraph + pointers (`mode`, `token_budget`) |
| `eap_graph_neighbors` | edges / BFS|DFS walk |
| `eap_graph_stats` | size/shape summary |
| `eap_graph_godnodes` | hub symbols |
| `eap_graph_path` | shortest path pointers |
| `eap_graph_communities` | label-propagation clusters |
| `eap_graph_central` | betweenness/degree ranking |
| `eap_graph_affected` | reverse-dep blast radius |
| `eap_graph_prs` | open PRs (`gh`) |
| `eap_graph_pr_impact` | one PR → affected |
| `eap_graph_reflect` | preferred/contested/clear (+ LESSONS.md) |
| `eap_graph_get_node` | single-node card |
| `eap_graph_explain` | structural explanation |
| `eap_graph_get_community` | members of community id |
| `eap_graph_triage_prs` | structural PR triage + overlap hints |

HTTP: `serve --transport http` (localhost, API key, 1 MiB body cap).

## CLI

```bash
export PYTHONPATH=layers/eap-context/src

python3 -m eap_context build <dir> [--update]
python3 -m eap_context query "text" --root <dir> [--mode bfs|dfs] [--token-budget N]
python3 -m eap_context explain Symbol --root <dir>
python3 -m eap_context export --root <dir> --format graphml|html|svg -o out
python3 -m eap_context merge-graphs dir1 dir2 -o merged.json [--global name]
python3 -m eap_context watch --root <dir> [--interval 2]
python3 -m eap_context stats|godnodes|neighbors|path|communities|central|affected|hook|prs|serve …
```

## Tests

```bash
cd EAP && python3 tests/test_context_engine.py
```

## Deliberate exclusions

- No tree-sitter / real parsers (regex + `ast` only)
- No LLM / semantic pass
- No PDF/image/audio/video
- No Neo4j / live graph-DB (file export only)
- Fuzzy is a narrow fallback, not a search engine

See `DESIGN.md` for the full rationale.
