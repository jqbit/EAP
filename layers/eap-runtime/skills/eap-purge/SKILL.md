---
name: eap-purge
description: >
  Maintenance: clear the EAP-Runtime offload store, or drop a single indexed
  document. Calls the eap_purge MCP tool — whole-store purge only after the
  user confirms, single-document purge when they name a pointer id. Reports
  exactly how many documents were removed. Use when the user says "eap purge",
  "clear the eap store", "drop that pointer", "reset the runtime index", or
  runs /eap-purge.
license: MIT
---

# EAP-Runtime purge

Call the `eap_purge` MCP tool (eap-runtime server).

## How to call

- User names a pointer (`eap_…`): call with `docId` — only that document is
  dropped.
- No pointer: this clears **every** indexed document. Destructive and not
  undoable — confirm once ("purge the whole store? offloaded output becomes
  unsearchable") before calling, unless the user already said explicitly to
  clear everything.

## Presentation

Report the tool's `removedDocs` count verbatim: "Removed N document(s)." For a
scoped purge with `removedDocs: 0`, say the pointer was not found (already
purged or mistyped) — do not claim success.

## Boundaries

- Session events and snapshots are not touched by eap_purge; only indexed
  documents/chunks are.
- One confirmation max, then comply (EAP-Signal rules still apply).
