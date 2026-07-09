---
name: eap-doctor
description: >
  Health-check the EAP-Runtime layer. Calls the eap_doctor MCP tool and
  presents its report: node version, node:sqlite + FTS5/trigram availability,
  per-language runtime availability for the polyglot executor, and store
  integrity. Flags failures with the concrete fix (e.g. Node >= 22 for
  node:sqlite — there is deliberately no fallback). Use when the user says
  "eap doctor", "is EAP healthy", "check the runtime store", "why is
  eap_execute failing", or runs /eap-doctor.
license: MIT
---

# EAP-Runtime doctor

Call the `eap_doctor` MCP tool (eap-runtime server), then present the report.

## Presentation

Group the result into four lines, worst news first:

1. **Store** — `store.ok` / integrity; if not `ok`, suggest `eap_purge` (after
   warning it clears indexed documents) or deleting `.eap/runtime.db`.
2. **SQLite** — `sqlite.ok`/`fts5`/`trigram`; a failure here means Node < 22 or
   a build without `node:sqlite`. The fix is upgrading Node — by design there
   is **no** third-party sqlite fallback.
3. **Runtimes** — list only the languages that are *missing*; the available
   ones need no airtime.
4. **Node/platform** — version + platform, one line.

All healthy: one line — "EAP-Runtime healthy" plus the store's measured stats
(bytes only, no percentages or dollar figures).

## Boundaries

- Diagnostic only — apply no fixes without the user asking.
- If the MCP server itself is unreachable, that IS the finding: report it and
  point to the installer (`node bin/eap-install.mjs`).
