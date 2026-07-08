# EAP-Lean — design notes

## The problem

Coding agents over-build. Given "add a cache," a fresh agent will write a cache
class with a TTL, an eviction policy, and a config object — when a one-line
stdlib decorator was the whole task. The waste is not just tokens; it is a
larger diff to review, more surface to break, and a dependency the repo did not
need. The failure mode is structural, so the fix is a **standing rule about how
to decide what to write**, not a one-off nudge.

## The discipline

EAP-Lean is that rule. Its spine is a seven-rung **decision ladder** — YAGNI →
reuse an in-repo helper → language stdlib → native platform/runtime feature →
already-installed dependency → one line → the minimum code that works — where
the agent stops at the first rung that holds. Around the ladder sit four
guards that keep "lazy" from becoming "careless":

1. **Understand first.** The ladder runs *after* the agent has read the task and
   traced the real end-to-end flow, never as a substitute for it. The smallest
   change in the wrong place is a second bug dressed up as efficiency.
2. **Root cause, not symptom.** Fix the shared function once, at the point every
   caller routes through, rather than patching the one path a ticket names.
3. **Safety carve-outs** ("never lazy about"): understanding, trust-boundary
   input validation, data-loss error handling, security, accessibility, real
   hardware/environment calibration, anything explicitly requested, and **one
   runnable check** behind every non-trivial logic path. These override brevity.
4. **A comment convention.** Every deliberate simplification is marked
   `// eap-lean: <ceiling> — upgrade path: <how>`, so a shortcut reads as intent
   and its known ceiling and revisit-trigger travel with the code. The
   `eap-lean:` marker is the anchor the debt harvester scans for.

Three intensity levels tune how aggressive the ladder is — **lite** (name the
lazier alternative, user picks), **full** (ladder enforced; the default), and
**ultra** (YAGNI-extremist) — plus **off**. The switch verb, `/eap lean
<level>`, mirrors `/eap signal <level>` so the two always-on disciplines share
one muscle-memory.

## Concept derivation from ponytail (no code taken)

EAP-Lean is **concept-derived** from ponytail by Dietrich Gebert
(https://github.com/DietrichGebert/ponytail, MIT). What EAP borrows is the
*idea* and *shape* of a code-brevity discipline:

- the "lazy senior dev" framing and the rung order of the ladder,
- the review tag vocabulary (`delete`/`stdlib`/`native`/`yagni`/`shrink`),
- the `net: -N lines` scoring of a review,
- the marker-comment-for-deliberate-simplification convention, and
- the specific safety carve-outs (validation, data loss, security,
  accessibility, calibration, the one-runnable-check rule).

What EAP does **not** take is any ponytail source: the rule text, the skill
prose, and the examples here are written fresh. ponytail was cloned only to
study its ladder and rules and re-express them faithfully in original words.
The marker is renamed `ponytail:` → `eap-lean:`, and the switch verb is
EAP's own `/eap lean`. This is the same clean-room posture EAP-Context takes
toward graphify and EAP-Runtime takes toward the context-offload pattern:
credit for the concept, zero code included. ponytail is MIT, so even a
code-derived work would be compatible — EAP stays concept-only anyway to keep
its "100% original / clean-room, zero third-party source" invariant intact.

## How it composes

EAP has four disciplines across an agent's token lifecycle, and Lean is
**orthogonal** to the other three:

| Discipline | Membrane | Shrinks |
|---|---|---|
| EAP-Context | input | reference material loaded *into* context |
| EAP-Runtime | working | tool output accreting *during* the turn |
| EAP-Signal | output | model prose emitted *back* to the user |
| **EAP-Lean** | **code** | **the code the agent writes into the repo** |

Signal and Lean are the two prompt-only, always-on disciplines, and they are
complementary by construction: **Signal shrinks the mouth, Lean shrinks the
hands.** Signal keeps code, commands, and paths byte-exact while trimming
prose; Lean decides that there should be *less code to keep exact in the first
place*. They install side by side into the same rules file behind their own
fenced markers (`<!-- eap-lean:begin -->` … `<!-- eap-lean:end -->`), upserted
and stripped independently.

Against Runtime and Context, Lean is simply orthogonal: those two change what
enters and leaves the context window; Lean changes what lands in the working
tree. There is no interaction to reconcile and no gain to multiply. Per EAP's
composition rule, any measured savings are reported per layer and **never
compounded into a single headline number**.

## Invariants

- **Prompt-only.** The ruleset and the three tooling skills are Markdown. No
  runtime, no network, no dependency. Zero supply-chain surface.
- **Deterministic.** The rule is fixed text; it adds no nondeterministic step.
- **Never trades correctness or safety.** The carve-outs are hard overrides,
  and the review/audit skills are scoped to complexity only — correctness,
  security, and performance findings route to a normal review pass.
- **Honest.** No upstream headline percentage is reprinted; the gain is
  workload-dependent and net-negative on already-lean code (the rule costs
  input tokens every turn).

## Non-goals

- Not a linter or formatter — it governs *decisions*, not style.
- Not a correctness/security review — that is a separate pass.
- Not an auto-fixer — the review, audit, and debt skills emit lists and change
  nothing on their own.
