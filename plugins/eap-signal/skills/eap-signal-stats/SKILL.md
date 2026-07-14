---
name: eap-signal-stats
description: >
  Show measured session prose/token stats for EAP-Signal. Reads the Claude Code
  session transcript when available — no invented savings percentages.
  Triggers on /eap-signal-stats. Prefer the hook-injected report when wired.
license: MIT
---

# EAP-Signal stats

One-shot report. Do NOT change Signal level.

When the hook is wired, `/eap-signal-stats` is answered by
`src/hooks/eap-signal-stats.mjs` (measured session output tokens / turns / model
+ active Signal level). The model need not invent numbers.

If the hook did not fire, run:

```bash
node <eap-repo>/src/hooks/eap-signal-stats.mjs
```

## Honesty

- Report **measured** session figures only (output tokens, turns, model id, active level).
- Do **not** invent savings percentages, dollar figures, or benchmark claims.
- Optional compressed-memory byte deltas (from `*.original.md` pairs) may be shown as raw bytes / ~chars÷4 token estimates, labelled approximate.
