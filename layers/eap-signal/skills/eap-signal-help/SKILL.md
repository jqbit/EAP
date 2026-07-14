---
name: eap-signal-help
description: >
  Quick-reference card for EAP-Signal modes, skills, and commands. One-shot
  display, not a persistent mode. Trigger: /eap-signal-help, "signal help",
  "what signal commands", "how do I use EAP-Signal".
license: MIT
---

# EAP-Signal help

Display this reference card when invoked. One-shot: do NOT change mode, write flag files, or persist anything.

## Levels

| Level | Trigger | What changes |
|-------|---------|--------------|
| **Lite** | `/eap signal lite` | Drop filler. Keep sentence structure. |
| **Full** | `/eap signal` / `/eap signal full` | Drop articles, filler, hedging. Fragments OK. Default. |
| **Ultra** | `/eap signal ultra` | Bare fragments. |
| **Wenyan-Lite** | `/eap signal wenyan-lite` | Classical Chinese, light. |
| **Wenyan-Full** | `/eap signal wenyan` | Full 文言文 (`wenyan` ≡ `wenyan-full`). |
| **Wenyan-Ultra** | `/eap signal wenyan-ultra` | Extreme classical. |
| **Off** | `/eap signal off` | Normal prose. |

Level persists until changed. Deactivate: "stop signal" / "normal mode".

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **eap-signal** | `/eap signal` | Mode / compression rules. |
| **eap-signal-commit** | `/eap-signal-commit` | Terse Conventional Commits. |
| **eap-signal-review** | `/eap-signal-review` | One-line PR comments. |
| **eap-signal-compress** | `/eap-signal-compress <file>` | Compress memory .md files. |
| **eap-signal-stats** | `/eap-signal-stats` | Measured session token/stats (no invented %). |
| **eap-signal-help** | `/eap-signal-help` | This card. |
| **eapcrew** | (delegate) | When to spawn eapcrew-* subagents. |

## Per-repo init

```bash
node src/tools/eap-signal-init.mjs [target-dir] [--dry-run] [--force] [--only <agent>]
```

## Peer layers

- EAP-Lean: `/eap lean` — shrinks code.
- EAP-Runtime / EAP-Context: MCP offload + symbol graph (not Signal).

## More

Rule text: `layers/eap-signal/EAP-SIGNAL.md` · README: `layers/eap-signal/README.md`.
