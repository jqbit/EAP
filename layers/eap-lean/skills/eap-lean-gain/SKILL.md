---
name: eap-lean-gain
description: >
  One-shot impact scoreboard for EAP-Lean — measured values only. Counts the
  `eap-lean:` markers actually in this repo and aggregates any "net: -N lines"
  figures the review/audit skills produced this session. NEVER prints a
  benchmark percentage, an upstream headline number, or a per-repo cost claim:
  the unbuilt version was never written, so there is no baseline to subtract
  from. One-shot display, not a persistent mode. Use when the user says "lean
  gain", "what does lean save", "show lean impact", "lean scoreboard", or runs
  /eap-lean-gain.
license: MIT
---

# EAP-Lean gain

Display a scoreboard when invoked. One-shot: do NOT change mode, write flag
files, or persist anything.

Every number on the card must be **measured in this repo, in this session**.
There are exactly two honest sources:

1. **Debt markers** — count them the same way `eap-lean-debt` does:

   ```
   grep -rnE '(#|//|--|;) ?eap-lean:' . \
     --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
   ```

   Each marker is one deliberate shortcut that shipped instead of the bigger
   build.

2. **Session net estimates** — any `net: -N lines possible` figure that
   `eap-lean-review` or `eap-lean-audit` emitted earlier in THIS session, and
   any diff you actually applied under the ladder this session (count the
   lines: they are in the transcript).

## Scoreboard

Render plain ASCII, only the rows you have data for:

```
  eap-lean gain                          this repo · measured only

  Shortcuts shipped lean     <N> eap-lean: markers   (<M> missing a trigger)
  Cuts identified            net: -<N> lines possible   (review/audit, this session)
  Cuts applied               -<N> lines               (diffs applied this session)

  Next:  /eap-lean-debt   (the ledger behind the marker count)
         /eap-lean-audit  (what's still cuttable)
```

No markers and no session figures: say so —
`No measured gain yet. Run /eap-lean-review on a diff or /eap-lean-audit on the repo.`

## Honesty boundary

- NEVER print a savings percentage, a cost figure, or a speed multiple. Those
  require a benchmark A/B; run [`../../bench/`](../../bench/) with your own API
  key if you want them.
- NEVER print an upstream headline number — the adapted-from project's
  measurements are its own, not this repo's.
- NEVER claim "you saved X lines/tokens/dollars here": in a live repo the
  over-built version was never written, so there is no real baseline. The only
  real per-repo figures are counted ones — the debt ledger and session diffs —
  and this card shows exactly those, nothing else.

## Boundaries

- One-shot display. Reads and reports only; edits nothing, changes no mode.
- "stop lean gain" or "normal mode" reverts.
