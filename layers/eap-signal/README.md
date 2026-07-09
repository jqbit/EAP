# EAP-Signal — output compression (shipping)

Verdict-first response style. Cuts filler, preamble, hedging, and validation
from the model's prose **output** while keeping code, commands, errors, paths,
and safety-critical text byte-exact.

This is the **output membrane** of EAP. It is prompt-only: no runtime, no
network, no dependency. It is the perfected TLDR prompt
(https://github.com/0point9bar/TLDR), which itself descends — with attribution — from
caveman by Julius Brussee. See `../../docs/legal/ATTRIBUTION.md`.

## Files

- `EAP-SIGNAL.md` — the canonical prompt (drop into any agent's memory/rules file).

## Levels

| Level | What changes |
|-------|--------------|
| **lite** | Drop filler/hedging. Sentences stay full. Professional but tight. |
| **full** | Default. Drop articles, fragments OK, short synonyms. |
| **ultra** | Bare fragments. Abbreviations (DB, auth, fn). Arrows for causality. |
| **wenyan-{lite,full,ultra}** | Classical-Chinese register for maximum character density. |

## What it does NOT do

- It does not compress **input** (that is EAP-Context) or **tool output**
  (that is EAP-Runtime). It shrinks the model's *mouth*, not its *ears* or
  *brain*.
- It never compresses safety warnings, irreversible-action confirmations, or
  code/commit/PR text.

## Honest numbers

Prose-output reduction is workload-dependent and is **net-negative on already
terse workloads** (the injected rules cost input tokens every turn). See the
TLDR project's `docs/HONEST-NUMBERS.md` for the measured cost/benefit picture;
EAP reprints no unverified headline percentage. See `../../docs/EFFICIENCY.md`.
