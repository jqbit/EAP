---
name: eap-stats
description: >
  Report what EAP-Runtime has kept out of the context window this session, in
  MEASURED terms only. Calls the eap_stats MCP tool and presents its numbers:
  documents indexed, chunks, bytes kept out (a real sum of indexed bytes), and
  the labelled ~bytes/4 token estimate. Never invents percentages or dollar
  figures. Use when the user says "eap stats", "how much has EAP saved",
  "bytes kept out", "runtime stats", or runs /eap-stats.
license: MIT
---

# EAP-Runtime stats

Call `eap_stats` (or `eap_report` for by-kind / TTL / path-tracked counts).
Never claim a hosted insight product — local measured numbers only.

## Presentation

Report exactly what the tool measured, one short block:

- `docs` — documents indexed this store.
- `chunks` — chunk rows behind them.
- `bytesKeptOut` — **measured** bytes kept out of context (a real sum of
  indexed bytes).
- `estimatedTokens` — repeat its label verbatim: a `~bytes/4` heuristic, an
  estimate, never exact.

## Honesty rule (hard)

Measured bytes only. Do **not** compute or state a percentage saved, a
dollar/cost figure, or any "vs dumping everything" comparison — there is no
honest baseline for one. If the user asks for a %, say the store measures
bytes, not counterfactuals, and point to `docs/EFFICIENCY.md`.

## Boundaries

- Read-only: never call eap_purge or mutate the store from here.
- If the eap-runtime MCP server is not registered, say so and suggest
  `eap_doctor` / the installer — do not fabricate numbers.
