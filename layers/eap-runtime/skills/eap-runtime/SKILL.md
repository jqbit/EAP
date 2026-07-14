---
name: eap-runtime
description: >
  Routing skill for EAP-Runtime: when to eap_execute vs eap_search vs eap_fetch
  (or eap_fetch_and_index / eap_index). Use when the agent is about to dump a
  large file, scrape a URL, or mine offloaded output; when the user says
  "think in code", "offload this", "use the runtime", or runs /eap-runtime.
  Prefer this over raw Read/Bash/WebFetch for oversized or network work.
license: MIT
---

# EAP-Runtime routing (execute vs search vs fetch)

Read `references/routing.md` for the decision table. Short form:

| Situation | Tool |
|---|---|
| Need a **fact from data on disk** (logs, JSON, CSV) without pasting it | `eap_execute` / `eap_execute_file` |
| Content already **indexed** (pointer `eap_…`) or vocabulary terms known | `eap_search` |
| Need bytes from the **network** | `eap_fetch` (inline/small) or `eap_fetch_and_index` (pointer + vocab) |
| Index a **local path/tree** for later search | `eap_index` |
| Several scripts and/or searches | `eap_batch_execute` |
| Measured store size only | `eap_stats` / `eap_report` |

## Hard rules

- Never invent $/% savings. Stats/report are measured bytes/docs only.
- Network from scripts is refused — use `eap_fetch*`.
- Default hooks **nudge**; hard deny only if `.eap/routing-enforce` exists.
- Prefer lossless `eap_search` chunks over paraphrasing offloaded bodies.

## Related skills

`eap-search`, `eap-index`, `eap-doctor`, `eap-stats`, `eap-purge`, `eap-upgrade`.
