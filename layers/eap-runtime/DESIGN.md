# EAP-Runtime — clean-room design specification

**This document is the specification.** EAP-Runtime is implemented **only** from
this description of the *pattern*. No source code, bundle, or test from any
Elastic-Licensed upstream is read or copied. See `../../docs/legal/ATTRIBUTION.md`.

The pattern (execute-in-subprocess, return-only-summary, index-the-rest) is a
general technique also found in OpenAI Code Interpreter and Anthropic's "code
execution with MCP." It is not novel to any one project and is described here in
first-principles terms.

## Problem

During an agent turn, tool output accretes in the context window: a 56 KB
Playwright snapshot, a 45 KB access log, 20 GitHub issues. Most of those bytes
are never needed after one derived fact is extracted. They crowd out reasoning
budget and cost money on every subsequent turn that re-sends the history.

## Mechanism (three moves)

1. **Think in code.** Instead of reading raw data into context, the agent writes
   a short script. EAP-Runtime runs it in a child subprocess against the raw
   data on disk, and **only the script's printed stdout re-enters context**. The
   56 KB log is `read` inside the subprocess; only `"500 requests, 12 errors,
   avg 34ms"` returns.

2. **Auto-offload oversized output.** When a script's stdout (or an indexed
   document/URL) exceeds a size threshold (default 100 KB), it is chunked and
   written to a local lexical index (SQLite full-text search), and context
   receives a **pointer** message: *"Indexed N sections under <id>. Query with
   eap_search(...)"*. Retrieval returns matching chunks (lossless) — not
   summaries.

3. **Session continuity.** Tool calls, edits, and decisions are logged to a
   per-project store. Before compaction, a small priority-tiered snapshot is
   written; at the next SessionStart it is rehydrated so working state survives
   compaction and `--continue`.

## Public interface (MCP tools, `eap_*`)

Deterministic, no LLM. `eap_execute*` has **no** network egress (network use is
blocked by policy and redirected to `eap_fetch`); `eap_fetch*` is the **only**
egress path and is SSRF-hardened (below). All 13 tools:

| Tool | Purpose |
|---|---|
| `eap_execute` | Run a script in a subprocess; return only stdout (auto-offloaded if large; `intent`-filtered on request). |
| `eap_execute_file` | Run an existing script file from disk (language inferred from extension). |
| `eap_batch_execute` | Run several scripts sequentially, bounded to 20. |
| `eap_index` | Chunk + index a file/blob/string into the local FTS store; return a pointer. |
| `eap_search` | Query the FTS store; return exact matching chunks (lossless) with source spans + a locator snippet. |
| `eap_fetch` | SSRF-hardened http/https fetch; HTML reduced to text; auto-offloaded (inline if small, pointer if large). |
| `eap_fetch_and_index` | Fetch + index a URL; return a searchable pointer + term vocabulary, never the raw body. |
| `eap_stats` | Report bytes kept out of context (measured) + an estimated token count (labelled ~bytes/4). |
| `eap_offload` | Inline-or-pointer decision for arbitrary content. |
| `eap_purge` | Maintenance: clear the store, or drop a single document. |
| `eap_doctor` | Self-check: node, language-runtime availability, `node:sqlite`/FTS5/trigram, store health. |
| `eap_session_snapshot` / `eap_session_restore` | Priority-tiered <=2 KB snapshot at PreCompact; rehydrate (+ memory pointers) at SessionStart. |

### Polyglot executor

`eap_execute*` shells out to a runtime already on the host — `python3`, `node`,
`bash`, `ruby`, `go` (`go run`), `rust` (`rustc` compile+run), `php`, `perl`,
`r` (`Rscript`), `elixir`, `typescript` (`tsx` → `deno` → `node --experimental-
strip-types`, first available wins), and `csharp` (`dotnet script`). A missing
runtime returns a clean `runtime-not-available` result — never a crash. The
source-text network deny-list is checked **before spawn** and covers the primary
egress idioms of every supported language — external binaries (curl/wget/nc),
inline HTTP (`fetch`/`requests`/`urllib`/`http.get`/`http.request`), Ruby
(`Net::HTTP`/open-uri), Go (`net/http`/`net.Dial`), PHP
(`file_get_contents(http…)`/`curl_*`/`fsockopen`), Perl (`LWP`/`IO::Socket`), C#
(`HttpClient`/`WebClient`), node core modules
(`require`/`import` of `net`/`http`/`https`/`tls`/`dgram`), bash `/dev/tcp`
pseudo-devices, R (`download.file`/`url()`/`httr`), and Elixir
(`:httpc`/`:gen_tcp`/HTTPoison). It is a **conservative source-text heuristic,
not an exhaustive interceptor**: a determined script can still reach the network
via a runtime primitive with no recognizable token (e.g. a raw socket built from
an already-imported handle, or a syscall). This is a policy tripwire that
redirects the obvious paths to `eap_fetch`; real containment is the isolation
layer, stated honestly under Security below.

### Retrieval (lossless, fused)

`eap_search` queries two FTS5 views of the same chunks — a `porter/unicode61`
table (stemmed keyword matching) and a `trigram` table (substring matching for
ids/paths/code) — and fuses their ranked lists with **Reciprocal Rank Fusion**
(RRF, k=60). A small title/source weight boosts chunks whose document label
matches a query term; stopwords are dropped from the keyword side. Results carry
an FTS5 `snippet()` locator **and** the exact chunk body — retrieval stays
lossless; the snippet is an extra field, never a replacement.

### Intent-driven filtering

When `eap_execute` stdout exceeds the offload threshold **and** the caller
supplies an `intent`, the full output is indexed and the result returns the
intent-matching chunks plus a short searchable **vocabulary** of the document's
salient terms — instead of a bare pointer.

## Storage

- One project root `.eap/`.
- A single SQLite database (`.eap/runtime.db`) with **two** FTS5 virtual tables
  over the chunk rows (`porter/unicode61` + `trigram`, fused at query time) plus
  a `docs` table and the session event log + snapshot tables.
- Uses the language runtime's **built-in** SQLite (`node:sqlite`, Node ≥ 22) so
  there is **no third-party runtime dependency** — supply-chain surface stays
  zero. There is deliberately **no native-sqlite fallback** (see exclusions).

## Session continuity (detail)

Events are logged with a priority-tiered taxonomy: tier 0 `decision`/`error`/
`rule`; tier 1 `edit`/`write`/`file_write`/`file_edit`/`task`; tier 2 `tool`/
`exec`/`file_read`/`git`/`intent`; tier 3 ambient `cwd`/`env`/`skill`/
`subagent`. Errors are classified deterministically (timeout / network /
permission / not-found / syntax / runtime / …) and tagged inline in the
snapshot. The snapshot stays hard-capped (~2 KB) and deterministic, but each
surviving section carries a runnable retrieval hint (`eap_search` /
`eap_session_restore`) so elided detail is recoverable. On restore, the presence
of project memory files (`CLAUDE.md` / `AGENTS.md`) is surfaced as retrievable
pointers — their **content is never read or injected**.

## Runtime & dependencies

- Node ≥ 22 (for stable `node:sqlite`). No npm runtime dependencies.
- The polyglot executor shells out to language runtimes already on the host
  (python3, node, bash, …); it does not bundle them.

## Security (stated honestly)

- The executor is a subprocess with a **policy deny-list** (blocks
  `curl`/`wget`/inline `fetch(http…)`/`requests.get` and polyglot equivalents),
  redirecting network I/O to `eap_fetch`. It **inherits host credentials** and is
  **not** OS-isolated. This is a policy control, documented as such — not a
  sandbox.
- `eap_fetch` / `eap_fetch_and_index` are the only egress path and are
  **SSRF-hardened** (validation, not OS sandboxing — stated honestly):
  - scheme allowlist — **http/https only** (file/ftp/gopher/data refused);
  - hard-block cloud-metadata/link-local (`169.254.0.0/16`, incl. IPv4-mapped
    IPv6), loopback (`127/8`, `::1`), unspecified, private (`10/8`, `172.16/12`,
    `192.168/16`), CGNAT, multicast, and reserved/future ranges, with their IPv6
    equivalents (`fc00::/7`, `fe80::/10`, `ff00::/8`, NAT64/IPv4-mapped decoded
    back to IPv4 and re-checked);
  - **DNS-rebinding defence** — the hostname is resolved once, every resolved
    address is validated, and the connection is *pinned* to the validated IP via
    node's `lookup` option so DNS cannot rebind between check and connect;
  - redirects are followed manually and **every hop is re-validated**;
  - a wall-clock timeout, a hard max-bytes cap, and a small TTL cache bound the
    fetch. HTML is reduced to text by a minimal dependency-free reducer.
- Real isolation (bwrap/landlock/containers) is an explicit later layer.

### Hardening applied (adversarial review)

An adversarial review of every untrusted boundary produced these fixes, each
with a regression test:

- **Timeout DoS / silent-coercion (fixed):** `eap_execute`'s caller-supplied
  `timeoutMs` is clamped to `[1, MAX_TIMEOUT_MS]` in `executor.mjs` — a value
  `> 2**31-1` no longer coerces to a 1 ms kill, and a multi-day value can no
  longer disable the only hard bound (and head-of-line-block the serve queue).
- **Untrusted MCP params (fixed):** the context server coerces/validates
  `depth`/`limit`/`top`/`degree_cap` (incl. float `Infinity` → `-32602`, not a
  `-32603` crash) and confines `eap_graph_build`'s `root` to within the server
  root (`realpath` containment).
- **Poisoned cache (fixed):** graph-cache node `file` paths are validated as
  in-tree relatives and `line` as a positive int, so a tampered cache cannot
  forge an out-of-tree `file:line` pointer; any load failure (incl.
  `RecursionError` from deeply-nested JSON) rebuilds rather than crashes.
- **ReDoS (fixed):** the JS/TS/Go symbol extractors were made provably
  linear-time (no adjacent unbounded whitespace groups; per-line anchoring).

### Accepted limitations (documented, not yet mitigated)

Honest disclosure — these are bounded, low-severity, and slated for the
isolation layer:

- **No OS resource limits (RLIMIT_AS/CPU/NPROC/FSIZE).** Within the wall-clock
  window a script can exhaust RAM/disk/procs. The process-group SIGKILL reaps a
  fork-bomb at timeout, but not before. Mitigation: `prlimit`/`ulimit` wrap in
  the isolation layer.
- **stdio frame size is not explicitly capped.** A single newline-free JSON-RPC
  frame is buffered before dispatch. In practice the frame is bounded by the
  calling model's max output (~MB), so this is not a real OOM vector; a hard
  cap lands with the isolation layer.
- **`.eap.json` hook config is trusted.** `eap-dispatch` reads `cfg.root` from
  the config file to locate layer modules; an attacker who can write that file
  (inside the user config dir) already controls the environment. Not an
  elevation across the trust boundary.

## Honesty

`eap_stats` reports **measured** bytes-kept-out (a real sum of indexed bytes),
plus an **estimated** token count labelled as a `~bytes/4` heuristic — never
presented as exact. There is **no** modeled percentage against a dump-all
strawman, **no** "99%" headline, and **no** dollar figure. See
`../../docs/EFFICIENCY.md`.

## Deliberate exclusions (scoped out here, on purpose)

- **No native-sqlite fallback.** The store requires built-in `node:sqlite`
  (Node ≥ 22). Falling back to a compiled `better-sqlite3`/`sqlite3` would
  reintroduce a third-party runtime dependency, which contradicts the zero-dep
  goal. A host without `node:sqlite` is a `eap_doctor` failure, not a fallback.
- **No 35-adapter installer matrix here.** This layer is the runtime + MCP tools
  only; provider install/adaptation lives elsewhere in the repo.
- **No dollar/percentage headline** in `eap_stats` (see Honesty).
- **Policy, not OS isolation.** The executor still inherits host credentials and
  lacks RLIMIT/OS sandboxing (see accepted limitations); real isolation is a
  later layer.

## Status

Implemented and tested on `node:sqlite`, zero third-party deps:
- `src/store.mjs` — dual-tokenizer FTS core with RRF fusion, snippets,
  source weighting, stopwords, vocabulary, purge, measured+estimated stats,
  health/probe (`../../tests/runtime-store.test.mjs`).
- `src/executor.mjs` — polyglot "think in code" executor (12 languages, graceful
  runtime detection), `executeFile`/`executeBatch`, intent-driven filtering,
  process-group kill + timeout clamp (`../../tests/executor.test.mjs`).
- `src/fetch.mjs` — SSRF-hardened `eap_fetch`/`eap_fetch_and_index` + HTML→text
  reducer (tested in `../../tests/mcp.test.mjs`).
- `src/session.mjs` — priority-tiered taxonomy, error classification, per-section
  retrieval hints, memory-file awareness (`../../tests/session.test.mjs`).
- `src/mcp.mjs` — newline-delimited JSON-RPC server wiring all 13 tools
  (`../../tests/mcp.test.mjs`).
