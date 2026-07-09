---
name: eap-search
description: >
  Retrieve exact chunks from the EAP-Runtime offload store. Calls the
  eap_search MCP tool (lossless, RRF-fused keyword + substring retrieval) and
  presents the matching chunks with their document id, chunk index, and locator
  snippet — never a summary in place of the chunk body. Use when the user says
  "eap search <query>", "search the offloaded output", "find that in the
  pointer", references a pointer id like eap_ab12…, or runs /eap-search.
license: MIT
---

# EAP-Runtime search

Call the `eap_search` MCP tool (eap-runtime server) with the user's query.

## How to call

- `query` — the user's terms, as given (the store fuses stemmed-keyword and
  substring matching itself; do not pre-mangle the query).
- `docId` — set it when the user names a pointer (`eap_…`) so retrieval is
  scoped to that document.
- `limit` — default 5; raise only if the user asks for more.

## Presentation

For each hit show: `docId` + chunk index (the source span), the snippet as a
locator, and the **exact chunk body** — retrieval is lossless; never replace
the body with your own summary. You may add interpretation *after* quoting.
No hits: say so and suggest terms (e.g. from a pointer's vocabulary) — do not
pad with guesses.

## Boundaries

- Read-only; never re-index or purge from here.
- If the store is empty or the server unregistered, say so plainly.
