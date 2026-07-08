# EAP-Lean — minimal-code craft (always-on)

A "lazy senior dev" discipline: the agent answers a coding task with the least
code that is correct and safe, having understood the problem first. It makes the
model climb a **decision ladder** (YAGNI → reuse → stdlib → native → installed
dep → one line → minimum) and stop at the first rung that holds — *after* it has
traced the real flow, never as a substitute for understanding it.

This is the **code membrane** of EAP, and a **peer of EAP-Signal**. It is
prompt-only: no runtime, no network, no dependency, deterministic. Where Signal
shrinks the model's *mouth* (its prose), Lean shrinks the model's *hands* (the
code it writes). Both are always-on rules that install into the same rules file;
`--no-lean` opts out of Lean while keeping Signal.

Concept-derived from **ponytail** by Dietrich Gebert (MIT) — the ladder shape,
the review tag vocabulary, and the safety carve-outs are re-expressed here in
original prose. **No ponytail source code is used.** See
`../../docs/legal/ATTRIBUTION.md`.

## Files

- `EAP-LEAN.md` — the canonical always-on rule (drop into any agent's memory/rules file).
- `DESIGN.md` — what it is, the concept-derivation from ponytail, how it composes with the other layers.
- `skills/` — three prompt-only tooling skills (review, audit, debt). No runtime.

## Levels

| Level | What changes |
|-------|--------------|
| **lite** | Build what's asked, but name the lazier alternative in one line. The user picks. |
| **full** | Default. The ladder enforced. Stdlib and native before custom. Shortest diff. |
| **ultra** | YAGNI-extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same breath. |
| **off** | Normal mode. |

Switch with `/eap lean lite|full|ultra|off` (where supported) — the same verb
shape as `/eap signal`. Level persists until changed.

## Safety carve-outs ("never lazy about")

Brevity never wins over these; they are hard overrides:

- **Understanding the problem** — the ladder shortens the solution, never the reading.
- **Input validation** at every trust boundary.
- **Error handling** that prevents data loss.
- **Security** and **accessibility** basics.
- **Anything explicitly requested** — the user wants the full version, build it.
- **Real hardware / environment calibration** — the platform is never the ideal on paper.
- **One runnable check** behind every non-trivial logic path (an `assert`-based demo or one small test). Lazy code without its check is unfinished.

## Tooling skills (prompt-only)

- `skills/eap-lean-review/` — over-engineering review of a diff → a tagged delete-list (`delete`/`stdlib`/`native`/`yagni`/`shrink`) + a `net: -N lines possible` estimate.
- `skills/eap-lean-audit/` — the same lens repo-wide, ranked biggest cut first.
- `skills/eap-lean-debt/` — harvest every `eap-lean:` comment into a debt ledger so deferred shortcuts don't rot silently.

All three read and report only — they never apply fixes, and correctness /
security / performance bugs are explicitly out of their scope.

## What it does NOT do

- It does not compress **prose output** (that is EAP-Signal), **input** (EAP-Context), or **tool output** (EAP-Runtime). It changes what the agent *writes*, not what enters or leaves the context window.
- It never simplifies away a safety carve-out (see above).
- The review/audit/debt skills never apply changes; they emit a list.

## Honest numbers

Code-reduction is **workload-dependent**. The gain is large where an agent would
otherwise over-build (a hand-rolled validator, a picker library, a speculative
abstraction) and **near zero — or net-negative — where the code is already
minimal**, because the injected rule costs input tokens every turn. EAP reprints
no upstream headline percentage; ponytail's own measurements are its per-task
ceiling, not a flat average. See `../../docs/EFFICIENCY.md`.
