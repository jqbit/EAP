---
name: eap-lean-audit
description: >
  Whole-repo audit for over-engineering — the eap-lean-review lens applied to
  the entire tree instead of one diff. Produces a ranked delete-list (biggest
  cut first), each line tagged delete/stdlib/native/yagni/shrink with what to
  cut and its replacement, ending in a "net: -N lines, -M deps possible"
  estimate. Complexity only; correctness, security, and performance are out of
  scope. One-shot report — applies nothing. Use when the user says "audit this
  codebase", "audit for over-engineering", "what can I delete from this repo",
  "find the bloat", "lean audit", or runs /eap-lean-audit.
license: MIT
---

# EAP-Lean audit

`eap-lean-review`, but repo-wide. Scan the whole tree instead of a diff and rank
the findings biggest cut first.

## Hunt for

- dependencies the standard library or platform already ships,
- single-implementation interfaces and factories with one product,
- wrappers that only delegate,
- files that export exactly one trivial thing,
- dead flags, dead config, unreachable branches,
- hand-rolled reimplementations of stdlib.

## Tags

Same vocabulary as `eap-lean-review`:

- `delete:` dead code, unused flexibility, a speculative feature. Replacement: nothing.
- `stdlib:` a hand-rolled thing the standard library ships. Name the function.
- `native:` a dependency or code doing what the platform already does. Name the feature.
- `yagni:` an abstraction with one implementation, config nobody sets, a layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Output

One line per finding, ranked, path last:

`<tag> <what to cut>. <replacement>. [<path>]`

End with:

`net: -<N> lines, -<M> deps possible.`

Nothing to cut: `Lean already. Ship.`

## Boundaries

- Scope is over-engineering and complexity ONLY. Correctness bugs, security
  holes, and performance route to a normal review pass.
- A single smoke test or `assert`-based self-check is the minimum, never flag it.
- One-shot report — lists findings, applies nothing.
- "stop lean audit" or "normal mode" reverts.
