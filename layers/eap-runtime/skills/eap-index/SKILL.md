---
name: eap-index
description: >
  Index a file, directory, or inline blob into the EAP-Runtime full-text store
  via eap_index. Returns pointer descriptor(s) for later eap_search. Use when
  the user says "index this", "eap index", "add to the offload store", or runs
  /eap-index. Prefer over dumping large trees into the chat.
license: MIT
---

# EAP-Runtime index

Call the `eap_index` MCP tool. See `references/index.md` for bounds and stale hashing.

## How to call

- **Path:** `{ path: "<file or dir>" }` — walks dirs (skips binaries, `.git`,
  `node_modules`, `.eap`, …), caps files and per-file bytes, reports truncation.
- **Inline:** `{ source: "<label>", content: "<text>" }`.

Path-indexed documents store a `content_hash`. Later `eap_search` may mark hits
`stale: true` when the on-disk file changed.

## After indexing

Point the user at `eap_search` (or the `eap-search` skill) with the returned
`id` / vocabulary terms. Do not paste the indexed body back into chat.
