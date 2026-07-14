---
description: Drop always-on EAP-Signal rule into the current repo for IDE agents
argument-hint: "[--dry-run|--force] [--only <agent>]"
---

Write per-repo EAP-Signal rule files (Cursor, Windsurf, Cline, Copilot, opencode, AGENTS.md) into the current repo, then report the result.

How to run:

1. If `src/tools/eap-signal-init.mjs` exists in the EAP checkout: `node src/tools/eap-signal-init.mjs $ARGUMENTS`
2. Otherwise from an installed EAP tree: `node <eap-repo>/src/tools/eap-signal-init.mjs $ARGUMENTS`

Use `--dry-run` first if the user did not pass `--force`.
