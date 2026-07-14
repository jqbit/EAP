# EAP-Runtime upgrade reference

## Safe core (MCP)

`eap_upgrade`:

1. Reports the installed EAP-Runtime version.
2. Resolves a target release tag (`vX.Y.Z` or `RELEASE-*`) via `git ls-remote`
   when `tag` is omitted — never tracks a mutable branch name as the target.
3. Migrates / integrity-checks `.eap/runtime.db`.
4. Re-runs `eap_doctor`.
5. Returns a pinned-tag **apply plan**. MCP auto-apply is refused when no
   checksum manifest exists.

## Apply via CLI (explicit consent)

When the user wants the plan applied and there is no checksum manifest:

```bash
eap update
eap update --ref vX.Y.Z     # pin the tag from the plan
eap update --check          # compare only
eap update --dry-run        # print plan, write nothing
```

Also: `node bin/eap.mjs update …` or `node bin/eap-install.mjs update …`.

Slash command: `/eap-update`. Skill: `eap-update`.

This fetches from GitHub `0point9bar/EAP`, refreshes the checkout, records
`~/.eap/install-state.json`, and runs `eap-install --non-interactive`.

## Manual apply (optional)

Each plan may still list raw git commands (`git fetch` + checkout of the pinned
tag, then `node bin/eap-install.mjs --non-interactive`). Prefer `eap update`.

## Doctor expectations after upgrade

Hooks registered, Node ≥ 22, `node:sqlite` FTS5+trigram, store `integrity: ok`.
Missing language runtimes are informational, not fatal to the core store.
