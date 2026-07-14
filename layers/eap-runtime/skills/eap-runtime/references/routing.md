# EAP-Runtime routing reference

Original EAP documentation. Pattern source: `layers/eap-runtime/DESIGN.md`.

## Decision ladder

1. **Already have a pointer?** Call `eap_search` with `docId`. Optional:
   `queries[]`, `contentType` (`code`|`prose`), fuzzy on by default.
2. **Local bytes, need a derived fact?** Write a short script → `eap_execute`.
   Only stdout returns; large stdout auto-offloads to a pointer.
3. **Local path to keep searchable?** `eap_index` with `path` (file or directory).
   Path-tracked docs get `content_hash`; search may flag `stale` if the file changed.
4. **HTTP(S) needed?** `eap_fetch` or `eap_fetch_and_index`.
   - TTL default 24h on indexed fetch content; `ttl: 0` disables; `force: true` bypasses cache.
   - Multiple URLs: `requests[]` + `concurrency` 1–8.
5. **Mix scripts + searches?** `eap_batch_execute` with optional `concurrency`.

## Hook behaviour

- **Default:** PreToolUse nudges large `Read`, `curl`/`wget` Bash, and `WebFetch`
  toward the tools above. PostToolUse offloads oversized tool output and logs
  file edits / errors / git / decisions into the session taxonomy.
- **Opt-in hard enforce:** create `.eap/routing-enforce` in the project. Then
  those paths are denied with redirect reasons (see layer README).

## Session continuity

- Stop → turn event; PreCompact → priority snapshot + Session Guide (≤ budget).
- SessionStart → restore last snapshot; memory files (`CLAUDE.md` / `AGENTS.md`)
  surfaced as presence pointers only — content never injected.

## Honesty

`eap_stats` / `eap_report` report measured indexed bytes and document counts.
No dollar figures, no modeled percentage saved.
