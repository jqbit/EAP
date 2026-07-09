# EAP-Runtime — working/tool-output offload (clean-room)

The **working membrane** of EAP. Keeps oversized tool output (logs, API blobs,
stdout) *out* of the context window: "think in code" (run a script, return only
its summary) and auto-offload large output into a local index behind a
searchable pointer.

**Independent clean-room reimplementation** of the context-offload pattern — no
Elastic-Licensed upstream source is used. See `DESIGN.md` (the specification
this is built from) and `../../docs/legal/ATTRIBUTION.md`.

## Built now

- `src/store.mjs` — the deterministic offload store on Node's built-in
  `node:sqlite` (FTS5). **Zero third-party runtime dependencies.**
  - `index(source, content)` → chunk + full-text index, return a pointer.
  - `search(query, {docId})` → **exact matching chunks** (lossless), with source
    spans and bm25 ranking. Never a summary.
  - `offload(source, content, {threshold})` → inline small content; pointer +
    hint for large content.
  - `stats()` → **measured** bytes kept out of context (a real sum, not a
    modeled percentage).
- Tests: `../../tests/runtime-store.test.mjs` (6 passing).

## Next (specified in `DESIGN.md`)

- The polyglot executor (`eap_execute*`) that runs scripts in a subprocess with
  a policy network-deny-list.
- MCP JSON-RPC framing (`eap_*` tools).
- Session-continuity snapshotting for `PreCompact` / SessionStart.

## Routing deny mode (opt-in)

Default hook behaviour is a **nudge** (additional context only). Creating the
flag file `.eap/routing-enforce` in a project switches the `PreToolUse` hook
(`src/hooks/eap-dispatch.mjs`) to hard-deny three raw paths and redirect to the
`eap_*` equivalent. Deny reason strings (source of truth:
`DENY_REASONS` in `src/hooks/eap-dispatch.mjs`):

- **Bash invoking curl/wget** — "EAP routing-enforce: network CLIs (curl/wget)
  are denied in this project. Use eap_fetch instead — it retrieves the URL
  through the SSRF-hardened allowlist and returns reduced text or a searchable
  pointer."
- **WebFetch** — "EAP routing-enforce: WebFetch is denied in this project. Use
  eap_fetch (inline text or pointer) or eap_fetch_and_index (searchable pointer
  + vocabulary) instead."
- **Read of an oversized file** (> the 100 KB offload threshold from
  `DESIGN.md`) — "EAP routing-enforce: raw Read of `<path>` (`<bytes>` bytes)
  exceeds the `<threshold>`-byte offload threshold. Use eap_execute (extract
  just the facts in a subprocess) or eap_index + eap_search (lossless chunk
  retrieval) instead."

Delete the flag file to return to nudge-only behaviour.

## Skills

Chat-invokable wrappers over the MCP tools live in `skills/`:
`eap-stats` (measured bytes only — never modeled %/$), `eap-search`,
`eap-doctor`, `eap-purge`.

## Requirements

Node ≥ 22 (for stable `node:sqlite`). No npm install needed for the core.

## Security (honest)

The executor is a subprocess with a **policy** deny-list, **not** OS isolation;
it inherits host credentials. Labeled as a policy control, not a sandbox. See
`../../docs/ARCHITECTURE.md` → Security posture.
