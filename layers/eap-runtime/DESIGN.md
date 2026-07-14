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
egress path and is SSRF-hardened (below). Tools:

| Tool | Purpose |
|---|---|
| `eap_execute` | Run a script in a subprocess; return only stdout (auto-offloaded if large; `intent`-filtered on request). |
| `eap_execute_file` | Run an existing script file from disk (language inferred from extension). |
| `eap_batch_execute` | Run several scripts and/or store searches (bounded to 20); optional concurrency 1–8. |
| `eap_index` | Chunk + index a file/blob/string into the local FTS store; return a pointer. Path indexes record `content_hash` for stale detection. |
| `eap_search` | Query the FTS store; lossless chunks with source spans + locator snippet. Supports `contentType`, `queries[]`, proximity rerank, fuzzy correction, optional throttle, stale flags. |
| `eap_fetch` | SSRF-hardened http/https fetch; HTML reduced to text; auto-offloaded (inline if small, pointer if large). |
| `eap_fetch_and_index` | Fetch + index; pointer + vocabulary. TTL (default 24h; `ttl:0` disables), `force`, parallel `requests[]` (concurrency 1–8). |
| `eap_stats` | Report bytes kept out of context (measured) + estimated token count (labelled ~bytes/4). |
| `eap_report` | Local measured summary: docs/chunks/bytes, by-kind, expired/path-tracked counts. No $/% claims. Not a hosted product. |
| `eap_offload` | Inline-or-pointer decision for arbitrary content. |
| `eap_purge` | Maintenance: clear the store, or drop a single document. |
| `eap_doctor` | Self-check: version, node, language runtimes, `node:sqlite`/FTS5/trigram, store health, hook registration. No native-sqlite heal. |
| `eap_upgrade` | Plan-only self-update: pinned tag, store migrate, doctor, apply plan (no auto-apply without checksums). |
| `eap_session_snapshot` / `eap_session_restore` | Priority-tiered <=2 KB snapshot (+ Session Guide) at PreCompact; rehydrate (+ memory pointers) at SessionStart. |

### Polyglot executor

`eap_execute*` shells out to a runtime already on the host — `python3`, `node`,
`bash`, `ruby`, `go` (`go run`), `rust` (`rustc` compile+run), `php`, `perl`,
`r` (`Rscript`), `elixir`, `typescript` (`tsx` → `deno` → `node --experimental-
strip-types`, first available wins), and `csharp` (`dotnet script`). A missing
runtime returns a clean `runtime-not-available` result — never a crash. The
source-text network deny-list is checked **before spawn** and covers the primary
egress idioms of every supported language. It is a **conservative source-text
heuristic, not an exhaustive interceptor**. Real containment is the isolation
layer, stated honestly under Security below.

### Chunking

- **Markdown:** heading-aware sections; fenced code blocks preserved as atomic
  units when they fit under the cap; oversized fences hard-split as last resort.
- **Other text:** paragraph packing with a ~2000-char cap.

### Retrieval (lossless, fused)

`eap_search` queries two FTS5 views of the same chunks — a `porter/unicode61`
table (stemmed keyword matching) and a `trigram` table (substring matching for
ids/paths/code) — and fuses their ranked lists with **Reciprocal Rank Fusion**
(RRF, k=60). Enhancements:

- **contentType** filter (`code`|`prose`|`all`) via a deterministic heuristic.
- **queries[]** — multi-query fusion in one call.
- **Proximity rerank** for multi-term queries (stdlib window score).
- **Fuzzy correction** — small edit-distance against store vocabulary when a
  query returns zero hits.
- **Optional progressive throttle** (`throttle` / `EAP_SEARCH_THROTTLE=1`).
- **Stale flags** — path-tracked docs compare on-disk `content_hash`.

Results carry an FTS5 `snippet()` locator **and** the exact chunk body —
retrieval stays lossless; the snippet is an extra field, never a replacement.

### Intent-driven filtering

When `eap_execute` stdout exceeds the offload threshold **and** the caller
supplies an `intent`, the full output is indexed and the result returns the
intent-matching chunks plus a short searchable **vocabulary** of the document's
salient terms — instead of a bare pointer.

### Fetch index TTL

`eap_fetch_and_index` assigns `expires_at` (default TTL 24h; overridable; `0`
means no expiry). `purgeExpired` runs at the start of fetch_and_index. `force`
bypasses the in-process fetch cache.

## Storage

- One project root `.eap/`.
- A single SQLite database (`.eap/runtime.db`) with **two** FTS5 virtual tables
  over the chunk rows (`porter/unicode61` + `trigram`, fused at query time) plus
  a `docs` table (`content_hash`, `path`, `expires_at`, `content_kind`) and the
  session event log + snapshot tables.
- Uses the language runtime's **built-in** SQLite (`node:sqlite`, Node ≥ 22) so
  there is **no third-party runtime dependency** — supply-chain surface stays
  zero. There is deliberately **no native-sqlite fallback** (see exclusions).

## Session continuity (detail)

Events are logged with a priority-tiered taxonomy: tier 0 `decision`/`error`/
`rule`; tier 1 `edit`/`write`/`file_write`/`file_edit`/`task`; tier 2 `tool`/
`exec`/`file_read`/`git`/`intent`; tier 3 ambient `cwd`/`env`/`skill`/
`subagent`/`turn`.

PostToolUse extractors (deterministic) enrich the log: files edited, errors,
git command summaries, decision markers. PreCompact builds a **Session Guide**
narrative into leftover snapshot budget (measured store stats only — no $/%).

Errors are classified deterministically (timeout / network / permission /
not-found / syntax / runtime / …) and tagged inline in the snapshot. The
snapshot stays hard-capped (~2 KB) and deterministic, but each surviving
section carries a runnable retrieval hint (`eap_search` / `eap_session_restore`)
so elided detail is recoverable. On restore, the presence of project memory
files (`CLAUDE.md` / `AGENTS.md`) is surfaced as retrievable pointers — their
**content is never read or injected**.

## Routing (hooks)

- **Default:** nudge — PreToolUse heuristics redirect large `Read`, `curl`/`wget`
  Bash, and `WebFetch` toward `eap_*` tools; graph nudge when Context is on.
- **Opt-in hard enforce:** create `.eap/routing-enforce` to deny those paths
  with redirect reasons (see README).

## Runtime & dependencies

- Node ≥ 22 (for stable `node:sqlite`). No npm runtime dependencies.
- The polyglot executor shells out to language runtimes already on the host
  (python3, node, bash, …); it does not bundle them.

## Security (stated honestly)

- The executor is a subprocess with a **policy deny-list**, redirecting network
  I/O to `eap_fetch`. It **inherits host credentials** and is **not**
  OS-isolated. This is a policy control, documented as such — not a sandbox.
- `eap_fetch` / `eap_fetch_and_index` are the only egress path and are
  **SSRF-hardened** (scheme allowlist; metadata/loopback/private blocked;
  DNS-rebinding pin; redirect re-validation; timeout + max-bytes + TTL cache).
- Real isolation (bwrap/landlock/containers) is an explicit later layer.

### Hardening applied (adversarial review)

An adversarial review of every untrusted boundary produced these fixes, each
with a regression test:

- **Timeout DoS / silent-coercion (fixed):** `eap_execute`'s caller-supplied
  `timeoutMs` is clamped to `[1, MAX_TIMEOUT_MS]` in `executor.mjs`.
- **Untrusted MCP params (fixed):** the context server coerces/validates
  numeric bounds; `eap_graph_build` `root` is confined via `realpath`.
- **Poisoned cache (fixed):** graph-cache node `file` paths validated as
  in-tree relatives.
- **ReDoS (fixed):** the JS/TS/Go symbol extractors are linear-time.

### Accepted limitations (documented, not yet mitigated)

- **No OS resource limits (RLIMIT_AS/CPU/NPROC/FSIZE).**
- **stdio frame size is not explicitly capped.**
- **`.eap.json` hook config is trusted.**

## Honesty

`eap_stats` / `eap_report` report **measured** bytes-kept-out (a real sum of
indexed bytes), plus an **estimated** token count labelled as a `~bytes/4`
heuristic — never presented as exact. There is **no** modeled percentage against
a dump-all strawman, **no** "99%" headline, and **no** dollar figure. See
`../../docs/EFFICIENCY.md`. There is **no** hosted insight/SaaS clone.

## Deliberate exclusions (scoped out here, on purpose)

- **No native-sqlite fallback.** A host without `node:sqlite` is a `eap_doctor`
  failure, not a fallback — and doctor never "heals" via better-sqlite3.
- **No 35-adapter installer matrix here.** Provider install lives elsewhere.
- **No dollar/percentage headline** in stats/report (see Honesty).
- **Policy, not OS isolation.** Real isolation is a later layer.
- **No Elastic / upstream product identifiers in code** (contamination guard;
  attribution only in `docs/legal/ATTRIBUTION.md`).

## Skills

Chat wrappers under `skills/`: `eap-runtime` (routing), `eap-index`,
`eap-search`, `eap-stats`, `eap-doctor`, `eap-purge`, `eap-upgrade` — each with
original EAP `references/` docs where useful.

## Status

Implemented and tested on `node:sqlite`, zero third-party deps:

- `src/store.mjs` — dual-tokenizer FTS, markdown chunking, RRF + proximity +
  fuzzy, stale/TTL/report (`../../tests/runtime-store.test.mjs`).
- `src/executor.mjs` — polyglot executor, batch mix scripts+searches + concurrency
  (`../../tests/executor.test.mjs`).
- `src/fetch.mjs` — SSRF-hardened fetch + HTML→text (`../../tests/mcp.test.mjs`).
- `src/session.mjs` — taxonomy, extractors, Session Guide
  (`../../tests/session.test.mjs`).
- `src/doctor.mjs` — expanded health checks.
- `src/mcp.mjs` — JSON-RPC wiring (`../../tests/mcp.test.mjs`).
- Hooks: `../../src/hooks/eap-dispatch.mjs` (`../../tests/dispatch.test.mjs`).
