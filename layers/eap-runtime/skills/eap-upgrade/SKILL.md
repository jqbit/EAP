---
name: eap-upgrade
description: >
  Plan-only EAP-Runtime self-update via eap_upgrade: reports current version,
  resolves a pinned release tag, migrates/checks the store, re-runs doctor, and
  returns an apply plan — nothing is fetched or executed automatically. Use when
  the user says "eap upgrade", "upgrade runtime", "check for EAP release", or
  runs /eap-upgrade. To *apply*, tell them to run CLI `eap update` (or /eap-update).
license: MIT
---

# EAP-Runtime upgrade (plan only)

Call `eap_upgrade` (optional `tag`). Present the plan; **do not apply** unless
the user explicitly asks.

To apply when checksums are unavailable: run the CLI (operator consent):

```bash
eap update
# or: eap update --ref <tag from the plan>
```

See `references/upgrade.md`.

## Presentation

1. Current version + target tag (pinned — never a mutable branch).
2. Store migrate / integrity result.
3. Doctor summary (failures first).
4. Apply steps verbatim from the tool — prefer the `eap update` line when present.
5. If the tool refuses auto-apply (no checksum manifest), point at CLI `eap update`
   rather than inventing an apply path.

## Boundaries

- MCP path is plan-only by default. Never silently pull or overwrite the checkout.
- CLI `eap update` / `/eap-update` is the consented apply path.
- No better-sqlite3 heal path; Node ≥ 22 + `node:sqlite` is required.
