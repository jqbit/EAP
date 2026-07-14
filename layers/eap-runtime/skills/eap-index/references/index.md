# EAP-Runtime index reference

## Bounds (defaults)

| Bound | Default | Notes |
|---|---|---|
| `maxFiles` | 200 | Directory walk stop |
| `maxFileBytes` | 262144 | Truncation flagged per file |
| Excluded dirs | `.git`, `node_modules`, `.eap`, `dist`, `build`, `target`, venv, … | Fixed list (no `.gitignore` parser) |

## Chunking

- Markdown: heading-aware; fenced code blocks kept intact when possible.
- Other text: paragraph packing with a ~2000-char cap.

## Stale detection

Documents indexed from a filesystem `path` record `content_hash`. Search results
include `stale` / `staleReason` (`changed`|`missing`|`unreadable`) when
`checkStale` is enabled (default).

## Related

Re-index after major edits, or search and treat `stale: true` as a hint to
re-run `eap_index` on that path. Purge with `eap_purge` / the `eap-purge` skill.
