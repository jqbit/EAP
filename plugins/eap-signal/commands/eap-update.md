---
description: Update EAP checkout from GitHub and re-run the installer
argument-hint: "[--check|--dry-run|--ref <tag|branch>|--force]"
---

Run the EAP self-update CLI via Bash (explicit consent — this applies the update):

```bash
eap update $ARGUMENTS
```

If `eap` is not on PATH, use the checkout:

```bash
node bin/eap.mjs update $ARGUMENTS
# or: node bin/eap-install.mjs update $ARGUMENTS
```

Present the command output. Do not invent versions. On success, note that hooks / Signal / Lean / skills / MCP were refreshed via `eap-install --non-interactive`.

Common flags: `--check` (report only), `--dry-run` (plan only), `--ref vX.Y.Z`, `--force` (hard reset — warn first).
