---
name: eapcrew
description: >
  Decision guide for delegating to EAP-Signal-compressed subagents. When to spawn
  eapcrew-investigator (locate), eapcrew-builder (1-2 file edit), or
  eapcrew-reviewer (diff review) instead of vanilla Explore. Compressed tool
  results keep more of main-context budget.
  Trigger: "delegate to subagent", "use eapcrew", "spawn investigator/builder/reviewer",
  "save context", "compressed agent output".
license: MIT
---

eapcrew = three subagent presets that emit EAP-Signal / TLDR-style output. Same jobs as Anthropic defaults (`Explore`, edit agents, reviewer); difference is the tool-result they return is compressed.

## When to use eapcrew vs alternatives

| Task | Use |
|---|---|
| "Where is X defined / what calls Y / list uses of Z" | `eapcrew-investigator` |
| Same but you also want suggestions/architecture commentary | `Explore` (vanilla) |
| Surgical edit, ≤2 files, scope obvious | `eapcrew-builder` |
| New feature / 3+ files / cross-cutting refactor | Main thread |
| Review diff, branch, or file for bugs | `eapcrew-reviewer` |
| Deep code review with rationale + alternatives | vanilla Code Reviewer |
| One-line answer you already know | Main thread, no subagent |

Rule of thumb: **if you'd want the subagent's output in ~1/3 the tokens, pick eapcrew. If you'd want prose, pick vanilla.**

## Output contracts

**`eapcrew-investigator`**
```
<Header>:
- path:line — `symbol` — short note
totals: <counts>.
```
Or `No match.`

**`eapcrew-builder`**
```
<path:line-range> — <change ≤10 words>.
verified: <re-read OK | mismatch @ path:line>.
```
Or terminal: `too-big.` / `needs-confirm.` / `ambiguous.` / `regressed.`

**`eapcrew-reviewer`**
```
path:line: <emoji> <severity>: <problem>. <fix>.
totals: N🔴 N🟡 N🔵 N❓
```
Or `No issues.`

## Chaining

1. investigator → sites
2. builder → 1-2 paths
3. reviewer → audit diff

## What NOT to do

- Don't use builder when you don't know the file — investigator first.
- Don't chain investigator→builder for a 5-file refactor — builder returns `too-big.`
- Don't ask reviewer for "general feedback" — findings only.
- Don't expect prose.

## Auto-clarity

Subagents drop compression for security warnings and irreversible-action confirmations.
