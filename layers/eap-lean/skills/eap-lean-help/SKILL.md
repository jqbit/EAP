---
name: eap-lean-help
description: >
  Quick-reference card for EAP-Lean: the levels (lite/full/ultra/off), the six
  skills (mode + tooling), the switch syntax, defaults env/config, and how to
  deactivate. One-shot display, not a persistent mode. Use when the user says
  "lean help", "what lean commands", "how do I use eap-lean", or runs
  /eap-lean-help.
license: MIT
---

# EAP-Lean help

Display this reference card when invoked. One-shot: do NOT change mode, write
flag files, or persist anything.

## Levels

| Level | Trigger | What changes |
|-------|---------|--------------|
| **lite** | `/eap lean lite` | Build what's asked; name the lazier alternative in one line. User picks. |
| **full** | `/eap lean full` | Default. Ladder enforced: YAGNI → reuse → stdlib → native → installed dep → one line → minimum. |
| **ultra** | `/eap lean ultra` | YAGNI-extremist. Deletion before addition; challenges the requirement in the same breath. |
| **off** | `/eap lean off` | Normal mode. |

Level persists until changed. EAP-Lean is always-on once installed (it lives in
the rules file); `--no-lean` at install time opts out while keeping EAP-Signal.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **eap-lean** | `/eap lean …` | Mode switch for skill-only hosts (`lite\|full\|ultra\|off`). |
| **eap-lean-review** | `/eap-lean-review` | Over-engineering review of a diff → tagged delete-list (`delete`/`stdlib`/`native`/`yagni`/`shrink`) + `net: -N lines possible`. |
| **eap-lean-audit** | `/eap-lean-audit` | Same lens repo-wide, ranked biggest cut first. |
| **eap-lean-debt** | `/eap-lean-debt` | Harvest `eap-lean:` shortcut comments into a tracked ledger. |
| **eap-lean-gain** | `/eap-lean-gain` | Measured-only scoreboard: marker count + this session's net figures. No benchmark claims. |
| **eap-lean-help** | `/eap-lean-help` | This card. |

Tooling skills (review/audit/debt/gain/help) read and report only. Correctness,
security, and performance bugs are out of their scope; route those to a normal review.

## Defaults

```bash
export EAP_LEAN_DEFAULT_MODE=ultra   # off|lite|full|ultra
# or ~/.config/eap/config.json → {"leanDefaultMode":"ultra"}  (Windows: %APPDATA%\eap\)
# or /eap lean default ultra
```

Subagent inject scoping: `EAP_SUBAGENT_MATCHER` / `EAP_LEAN_SUBAGENT_MATCHER`
(regex on `agent_type`).

## The peer layer

`/eap signal` re-applies EAP-Signal (verdict-first prose). Signal shrinks the
mouth; Lean shrinks the code. They install into the same rules file and
compose.

## Deactivate

Say "stop lean" or "normal mode". Resume with `/eap lean full` (or any level).

## More

Rule text: `layers/eap-lean/EAP-LEAN.md` · design: `layers/eap-lean/DESIGN.md` ·
worked examples: [`../../examples/`](../../examples/) · benchmark harness:
[`../../bench/`](../../bench/).
