---
name: eap-lean-review
description: >
  Over-engineering review of a diff — nothing else. Emits a delete-list: one
  line per finding, each tagged delete/stdlib/native/yagni/shrink, giving the
  location, what to cut, and what replaces it. Ends with a single
  "net: -N lines possible" estimate. Complexity only — correctness bugs,
  security holes, and performance are explicitly OUT of scope; route those to a
  normal review. Lists findings, applies nothing. Use on a code change when the
  user says "review for over-engineering", "what can we delete", "is this
  over-built", "lean review", or runs /eap-lean-review.
license: MIT
---

# EAP-Lean review

Read the diff for one thing: unnecessary complexity. The best outcome for a diff
is getting shorter. One line per finding — location, what to cut, what replaces
it — then a net estimate.

## Format

`L<line>: <tag> <what>. <replacement>.`

For a multi-file diff, prefix the path: `<file>:L<line>: <tag> <what>. <replacement>.`

## Tags

- `delete:` dead code, unused flexibility, a speculative feature. Replacement: nothing.
- `stdlib:` a hand-rolled thing the language standard library already ships. Name the function.
- `native:` a dependency or code doing what the platform/runtime already does. Name the feature.
- `yagni:` an abstraction with one implementation, a config nobody sets, a layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Examples

Avoid the hedging verbose form:

> "This `EmailValidator` class may be more complex than strictly necessary — have you considered whether every rule is needed at this stage?"

Prefer the terse tagged form:

- `L12-38: stdlib: 27-line email validator. "@" in address is one line; the real check is the confirmation mail.`
- `L4: native: a date library imported for one format call. Intl.DateTimeFormat, zero deps.`
- `repo.py:L88: yagni: AbstractRepository with a single implementation. Inline it until a second one exists.`
- `L52-71: delete: retry wrapper around an idempotent local call. Nothing replaces it.`
- `L30-44: shrink: manual loop builds a dict. dict(zip(keys, values)), one line.`

## Scoring

End with the only number that matters:

`net: -<N> lines possible.`

If there is nothing to cut, say `Lean already. Ship.` and stop.

## Boundaries

- Scope is over-engineering and complexity ONLY. Correctness, security, and
  performance are out of scope — send them to a normal review pass.
- A single smoke test or `assert`-based self-check is the EAP-Lean minimum, not
  bloat. Never flag it for deletion.
- Lists findings; applies no fixes.
- "stop lean review" or "normal mode" reverts to the verbose review style.
