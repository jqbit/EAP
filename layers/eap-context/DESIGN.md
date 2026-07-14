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
    ClassDef / Import / ImportFrom; refs = call names, decorators, class bases;
    class bases also emit `inherits`).
  - Regex extractors (same linear-time discipline — `^`-anchored, `[ \t]` only,
    bounded tokens, minified-line neutralization, ReDoS tests):
    JS/TS, Go, Rust, Java, C/C++, C#, Ruby, PHP, **Kotlin, Scala, Swift, Lua,
    Zig, Bash, Elixir, Julia, Dart, Terraform/HCL, SQL, PowerShell**, plus
    **Vue/Svelte** (script blocks → JS extractor), **JSON** (shallow top keys),
    **Markdown** (headings), **YAML** (indent-0 keys).
  - Where regexes can see them, `extends` / `: Base` / `implements` / `with`
    populate optional `inherits` / `implements` lists (and dedicated edge
    relations at resolve time). Ceilings are marked with `eap-lean:` comments.
  - Binary and very large files are skipped.
- **Manifest ingest** (`src/eap_context/manifest.py`): `pyproject.toml`,
  `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt` → synthetic
  `dependency` nodes and `depends_on` edges (`tomllib` on 3.11+, tiny table
  fallback otherwise; `json` for package.json; line scan for go.mod /
  requirements.txt). Names only — no network resolution.
- **Graph build** (`src/eap_context/graph.py`): nodes are symbols keyed by a
  qualified id; edges carry `EXTRACTED` (explicit / same-file) vs `INFERRED`
  (cross-file by name) provenance. Relations:
  `defines | calls | references | imports | inherits | implements | depends_on`.
  Symlinks are not followed out of the root. On each `build_and_save`,
  label-propagation community ids are stamped onto nodes and persisted to
  `.eap/communities.json`.
- **Ignore rules** (`src/eap_context/ignore.py`): gitignore-syntax rules from
  **every** `.gitignore` / `.eapignore` under the tree (directory-scoped, last
  match wins; `.eapignore` after `.gitignore` at the same level). Hardcoded
  defaults still prune first.
- **Materialized cache**: node-link JSON at `<root>/.eap/graph.json`, written
  atomically. Cached node paths are validated to stay relative and within the
  root.
- **Incremental indexing**: `<root>/.eap/index.json` fingerprint cache
  `(size, mtime_ns, sha256)` + symbols; `build --update` / `incremental: true`.
- **Query** (`src/eap_context/query.py`): substring/IDF seed scoring, bounded
  **BFS or DFS** expansion, god-node degree cap, fuzzy fallback, optional
  **token_budget** packing (~chars/4), reflect-tag overlay. Pointers only.
  Also: `get_node`, `explain` (structural "why"), `get_community`.
- **Graph algorithms** (`src/eap_context/algorithms.py`): shortest_path,
  communities (label-propagation), centrality (Brandes / degree), affected
  (reverse-dep closure).
- **Export** (`src/eap_context/export.py`): GraphML + minimal HTML/SVG
  (stdlib `xml.etree` / circular layout). `merge-graphs` unions per-root
  caches; optional write under `~/.eap/global/<name>.json`.
- **Watch** (CLI): polling mtime stamp — no `watchdog` dependency.
- **Git-hook auto-rebuild** (`hooks.py`): post-commit / post-checkout →
  `build --update`.
- **PR tooling** (`prs.py`): `gh` CLI list/impact; **worktree map** via
  `git worktree list`; **triage_prs** structural ranking by blast radius +
  overlapping affected-file **conflict hints** (no LLM).
- **Query log + reflect** (`reflect.py`): JSONL query log; preferred/contested
  tags; optional **`.eap/LESSONS.md`** rewrite for preferred outcomes.

## Public interface (MCP tools, `eap_graph_*`)

16 tools: `build`, `query`, `neighbors`, `stats`, `godnodes`, `path`,
`communities`, `central`, `affected`, `prs`, `pr_impact`, `reflect`,
`get_node`, `explain`, `get_community`, `triage_prs` — JSON-RPC 2.0 on stdio
or keyed HTTP. CLI adds `explain`, `export`, `merge-graphs`, `watch` on top
of the existing commands.

## Integration on the EAP spine

- Registered as an **MCP server** by the shared installer —
  `python3 …/mcp.py <root>`.
- The `PreToolUse` hook nudges a graph query before a large raw file read.
- Retrieval routing: code-symbol queries here; blob/log/doc queries to
  EAP-Runtime's FTS store.

## Runtime & dependencies

Python 3 standard library only — **zero third-party dependencies** (`ast`,
`re`, `json`, `os`, `math`, `bisect`, `hashlib`, `hmac`, `secrets`,
`argparse`, `collections`, `subprocess`, `shlex`, `http.server`, `threading`,
`xml.etree`, `tomllib`/`html`, `time`). No tree-sitter, networkx, numpy,
rapidfuzz, jieba, watchdog, or third-party MCP package. External processes
(`git`, `gh`) via validated `subprocess` only.

## Deliberate exclusions (out of scope)

These remain conscious non-goals:

- **No tree-sitter / real parsers.** Regex + `ast` only — shallower than
  graphify's ~40 grammars; prefer false negatives; linear-time extraction.
- **No LLM / semantic pass.** No embeddings, no model-scored relevance, no
  natural-language summarisation of PRs or communities.
- **No non-code modalities.** No PDF, image, audio, or video ingestion.
- **No graph-DB backends.** No Neo4j. Export is file-based GraphML/HTML/SVG
  only (stdlib), not a live viewer dependency.
- **Fuzzy matching is a narrow fallback** — bounded Levenshtein ≤2 over
  trigram-pruned candidates. No rapidfuzz.

## Correctness & safety

Pointers not summaries; stale/missing graph → ordinary read/grep. Extraction
stays linear-time across languages. Caches (graph, index, communities,
reflect, querylog) are untrusted on read. Git refs and `gh`/`git` args are
validated. HTTP transport requires a constant-time API key and bounds body
size. Hook install never clobbers a foreign hook.
