---
name: eap-update
description: >
  Apply EAP self-update from the CLI: fetch GitHub 0p9b/EAP, refresh the
  checkout (ff-only branch or latest release tag), record install-state, and
  re-run the installer. Use when the user says "eap update", "update EAP",
  "pull latest EAP", or runs /eap-update. Distinct from plan-only eap_upgrade.
license: MIT
---

# EAP update (CLI apply)

Run via Bash (this **applies** — the user asked for `/eap-update` / `eap update`):

```bash
eap update
# or: node bin/eap.mjs update
# or: node bin/eap-install.mjs update
```

## Flags

| Flag | Meaning |
|------|---------|
| `--check` | Current vs remote; no checkout/install |
| `--dry-run` | Print plan only |
| `--ref <tag\|branch>` | Explicit target |
| `--force` | Hard reset to origin/ref (warn first) |

Extra flags after `--` (or unknown install flags) are passed to
`eap-install --non-interactive`.

## Checkout resolution

`$EAP_HOME` → `~/.eap/src` → current repo if it is an EAP git checkout → else
clone `https://github.com/0p9b/EAP.git` to `~/.eap/src`.

## vs eap_upgrade

- **MCP `eap_upgrade`**: plan-only when no checksum manifest (safe for agents).
- **CLI `eap update`**: applies — operator typed it (explicit consent).

After success, optional: `eap doctor` or MCP `eap_doctor`.
