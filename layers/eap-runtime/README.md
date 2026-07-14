# EAP-Runtime — working/tool-output offload (clean-room)

The **working membrane** of EAP. Keeps oversized tool output (logs, API blobs,
stdout) *out* of the context window: "think in code" (run a script, return only
its summary) and auto-offload large output into a local index behind a
searchable pointer.

**Independent clean-room reimplementation** of the context-offload pattern — no
Elastic-Licensed upstream source is used. See `DESIGN.md` (the specification
this is built from) and `../../docs/legal/ATTRIBUTION.md`.

## Built now

- `src/store.mjs` — Node built-in `node:sqlite` (FTS5). **Zero third-party
  runtime dependencies.**
  - Heading-aware markdown chunking (fences preserved).
  - `index` / `search` / `offload` / `stats` / `report` / `purgeExpired`.
  - Search: `contentType`, `queries[]`, proximity rerank, fuzzy zero-hit
    correction, optional throttle, stale flags via `content_hash` on paths.
  - Fetch-index TTL (default 24h) on docs with `expires_at`.
- `src/executor.mjs` — polyglot execute; batch mixes scripts + searches;
  concurrency 1–8.
- `src/fetch.mjs` — SSRF-hardened fetch; `eap_fetch_and_index` supports TTL,
  `force`, parallel `requests[]`.
- `src/session.mjs` — taxonomy + PostToolUse extractors (edits/errors/git/
  decisions) + Session Guide in PreCompact snapshots.
- `src/doctor.mjs` / `eap_doctor` — version, hooks, sqlite, store (no
  better-sqlite3 heal).
- `eap_report` — local measured summary only (not a hosted SaaS clone).
- Tests under `../../tests/` (`runtime-store`, `session`, `mcp`, `dispatch`, …).

## Routing deny mode (opt-in)

Default hook behaviour is a **nudge** (additional context for large Read, Bash
dumps, curl/wget, WebFetch → `eap_*`). Creating `.eap/routing-enforce` switches
`PreToolUse` to hard-deny. Deny reason strings (source of truth: `DENY_REASONS`
in `src/hooks/eap-dispatch.mjs`):

- **Bash invoking curl/wget** — use `eap_fetch`.
- **WebFetch** — use `eap_fetch` / `eap_fetch_and_index`.
- **Read of an oversized file** (> 100 KB) — use `eap_execute` or
  `eap_index` + `eap_search`.
- **Heavy Bash dumps** (`cat *.log`, broad `find -type f`) — use execute/index.

Delete the flag file to return to nudge-only behaviour.

## Skills

Under `skills/`: `eap-runtime` (routing), `eap-index`, `eap-search`,
`eap-stats`, `eap-doctor`, `eap-purge`, `eap-upgrade` — with original
`references/` docs. Installed by `bin/eap-install.mjs`.

## Requirements

Node ≥ 22 (for stable `node:sqlite`). No npm install needed for the core.

## Security (honest)

The executor is a subprocess with a **policy** deny-list, **not** OS isolation;
it inherits host credentials. Labeled as a policy control, not a sandbox. See
`../../docs/ARCHITECTURE.md` → Security posture.

## Honesty

Measured bytes and document counts only. No dollar or percentage savings claims
in tools, skills, or Session Guide text.
