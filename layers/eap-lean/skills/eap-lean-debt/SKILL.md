---
name: eap-lean-debt
description: >
  Harvest every `eap-lean:` comment in the codebase into a debt ledger, so the
  deliberate shortcuts EAP-Lean leaves behind stay tracked instead of rotting
  into "later means never". One row per marker: what was simplified, the ceiling
  it named, and the trigger to revisit. Flags any marker with no upgrade path as
  a silent-rot risk. One-shot report — changes nothing unless asked to persist
  it. Use when the user says "lean debt", "what did lean defer", "list the
  shortcuts", "lean ledger", "what did we mark to do later", or runs
  /eap-lean-debt.
license: MIT
---

# EAP-Lean debt

Every deliberate EAP-Lean shortcut is marked with an `eap-lean:` comment naming
its ceiling and upgrade path. This skill collects them into one ledger so a
deferral can't quietly become permanent.

## Scan

Grep the repo for the marker, skipping `node_modules`, `.git`, and build output:

```
grep -rnE '(#|//|--|;) ?eap-lean:' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
```

Add other comment prefixes if your stack uses them. Requiring the comment prefix
keeps prose that merely mentions the convention out of the ledger. Each hit is
one ledger row.

## Output

One row per marker, grouped by file. The convention is
`eap-lean: <ceiling> — upgrade path: <how>`, so pull the ceiling and the trigger
straight from the comment:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

Want an owner per row? add `git blame -L<line>,<line>`.

Flag the rot risk: any `eap-lean:` comment that names no upgrade path or trigger
gets a `no-trigger` tag — those are the ones that silently rot.

End with: `<N> markers, <M> with no trigger.`

Nothing found: `No eap-lean: debt. Clean ledger.`

## Boundaries

- Reads and reports only; changes nothing.
- To persist it, ask — then it writes the ledger to a file (e.g. `EAP-LEAN-DEBT.md`).
- One-shot. "stop lean debt" or "normal mode" reverts.
