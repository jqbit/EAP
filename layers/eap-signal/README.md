# EAP-Signal — output compression (shipping)

Verdict-first response style. Cuts filler, preamble, hedging, and validation
from the model's prose **output** while keeping code, commands, errors, paths,
and safety-critical text byte-exact.

This is the **output membrane** of EAP. Beyond the always-on prompt rule it now
ships the TLDR-derived user-facing suite (skills, eapcrew agents, slash
commands, optional MCP shrink, per-repo init) under EAP naming. Adapted from
TLDR (preferred) and caveman (second), both MIT. See `../../docs/legal/ATTRIBUTION.md`.

## Files

| Path | Role |
|------|------|
| `EAP-SIGNAL.md` | Canonical always-on prompt (installer managed block) |
| `rules/eap-signal-activate.md` | Compact per-repo init body |
| `skills/` | `eap-signal`, commit/review/stats/compress/help, `eapcrew` |
| `agents/` | `eapcrew-investigator`, `eapcrew-builder`, `eapcrew-reviewer` |
| `commands/` | Claude/Gemini slash command markdown + toml |
| `mcp-servers/eap-signal-shrink/` | Optional MCP description-field compressor |
| `../../src/tools/eap-signal-init.mjs` | Per-repo always-on init |
| `../../src/hooks/eap-signal-stats.mjs` | Measured session stats (no invented %) |
| `../../src/hooks/eapcrew-model-overrides.mjs` | Env model pins for eapcrew agents |

## Levels

| Level | What changes |
|-------|--------------|
| **lite** | Drop filler/hedging. Sentences stay full. Professional but tight. |
| **full** | Default. Drop articles, fragments OK, short synonyms. |
| **ultra** | Bare fragments. Prefer dropping words over invented abbreviations. |
| **wenyan-{lite,full,ultra}** | Classical-Chinese register. Bare `wenyan` ≡ **wenyan-full**. |
| **off** | Normal prose. |

Independent skill modes (flag only; skip base-Signal reinforcement): `commit`,
`review`, `compress` via `/eap-signal-commit` etc.

## Install

```bash
node bin/eap-install.mjs --only claude
# optional MCP shrink wrapping an upstream:
node bin/eap-install.mjs --only claude --with-mcp-shrink="npx @modelcontextprotocol/server-filesystem /tmp"
# per-repo init (Cursor/Windsurf/Cline/Copilot/opencode/AGENTS.md):
node src/tools/eap-signal-init.mjs --dry-run
```

Natural-language activate: "tldr mode", "activate EAP-Signal", "talk TLDR".
Stop: "stop signal" / "stop tldr" / "normal mode".

## What it does NOT do

- It does not compress **input** (EAP-Context) or **tool output** (EAP-Runtime).
- It never compresses safety warnings, irreversible-action confirmations, or
  code/commit/PR text (boundaries in the skill + Auto-Clarity).

## Honest numbers

Prose-output reduction is workload-dependent. `/eap-signal-stats` reports
**measured** session figures only — no invented savings percentages. See
`../../docs/EFFICIENCY.md` and TLDR `docs/HONEST-NUMBERS.md`.
