# Attribution & Provenance

**EAP** (Efficient Agent Protocol) is an independent, MIT-licensed project
maintained solely by [ZeroPointNineBar](https://github.com/0point9bar). It is a self-contained
hard fork/freeze with no upstream runtime dependency. This file records the
lineage of every idea and every line of third-party code, per layer.

## EAP-Signal (output compression)

Descends from **TLDR** (ZeroPointNineBar, MIT), which itself derives — with attribution —
from **caveman** by Julius Brussee (MIT) and ZeroPointNineBar's earlier TAUT→STFU→blunt
prompt lineage. The "compress like a caveman, sound like a senior engineer"
design (drop the persona, keep the compression) is documented in TLDR's
`data/philosophy.md`. All of this lineage is MIT and libre-compatible.

- **caveman** — https://github.com/JuliusBrussee/caveman — MIT, © 2026 Julius Brussee.
- **ponytail** by Dietrich Gebert — https://github.com/DietrichGebert/ponytail — MIT.
  EAP-Lean (`layers/eap-lean/`) is a **concept-derived, clean-room code-brevity
  discipline** whose spine is ponytail's *concept* of a decision ladder (YAGNI →
  reuse an in-repo helper → stdlib → native → installed dep → one line →
  minimum), plus the review tag vocabulary (`delete`/`stdlib`/`native`/`yagni`/
  `shrink`), the `net: -N lines` scoring, the deliberate-simplification comment
  convention (renamed `ponytail:` → `eap-lean:`), and ponytail's safety
  carve-outs (understanding, input validation, data-loss error handling,
  security, accessibility, hardware calibration, one runnable check). **EAP-Lean
  is a documentation derivative of ponytail, not a concept-only clean room:** its
  rule text, tag vocabulary, scoring strings, and worked examples are close
  adaptations of ponytail's, and some sentences are verbatim. The derivation also
  covers **code**, not just prose: the example corpus
  (`layers/eap-lean/examples/`, including clearly-marked verbatim upstream
  benchmark transcripts) and the benchmark harness
  (`layers/eap-lean/bench/` — task configs, correctness/LOC gates, runner
  scripts) are ports of ponytail's `examples/` and `benchmarks/`. ponytail is MIT,
  so this is fully licence-compatible; per MIT its copyright and permission notice
  is retained in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). What EAP-Lean
  does **not** take is ponytail's runtime (hooks, mode tracker, MCP server) — that
  is reimplemented independently. EAP-Lean is a peer of EAP-Signal (Signal shrinks
  the prose; Lean shrinks the code), prompt-only and always-on.

## EAP-Context (input / retrieval)

**Concept-derived from graphify — independent implementation, no code taken.**

- **graphify** — https://github.com/Graphify-Labs/graphify — **MIT License**,
  © 2026 Safi Shamsi. EAP-Context is an **independent, Python-standard-library-
  only** symbol-graph engine whose *design* is informed by graphify's
  code-graph approach (AST-derived symbol graph → bounded traversal → `file:line`
  pointers instead of file dumps). It uses **no graphify source code** and
  **none of graphify's dependencies** (tree-sitter, networkx, numpy, rapidfuzz,
  the `mcp` package). Because zero code is copied, there is no MIT notice to
  retain from a code-inclusion standpoint — graphify is credited here for the
  concept as a matter of good faith and honesty.
- Building a lean stdlib engine (rather than vendoring graphify's ~20-package
  dependency tree) is a deliberate hard-freeze choice: it keeps EAP's
  supply-chain surface at zero, which is a core project requirement.
- The graphify **name and branding are not used**; EAP uses its own mark.

## EAP-Runtime (working / tool-output offload)

**Independent clean-room reimplementation.** The context-offload pattern
("think in code": run a script in a subprocess and return only its summary;
auto-index oversized output behind a searchable pointer; persist session state
across compaction) is a general technique also seen in OpenAI Code Interpreter
and Anthropic's "code execution with MCP." EAP-Runtime implements it from a
written specification only.

- **context-mode** by Mert Köseoğlu (mksglu) —
  https://github.com/mksglu/context-mode — **Elastic License 2.0 (ELv2)**.
  ELv2 is **not** an open-source / libre license. **EAP uses zero context-mode
  source code.** EAP-Runtime was written from the architecture specification in
  `layers/eap-runtime/DESIGN.md` (a description of the *pattern*), by an
  implementer who did not read context-mode's TypeScript source or its
  distributed bundles. ELv2 obligations attach only to copied or distributed
  ELv2 software; a genuine clean-room reimplementation carries none. The
  context-mode **name/marks are not used**. No context-mode NOTICE or
  attribution file exists upstream, and because we copy nothing, there is
  nothing to carry.

## Contamination guard

`scripts/check-contamination.sh` fails the build on any occurrence of upstream
ELv2 identifiers (`context-mode`, `mksglu`, `Koseoglu`/`Köseoğlu`, `Elastic-2.0`,
`ELv2` outside this attribution file) or any vendored upstream bundle
(`*.bundle.mjs`). Clean-room contamination is a red build, not a lawsuit.

## Summary

EAP ships **MIT** with **no third-party runtime dependencies** and **no ELv2
(context-mode) source** — a genuine clean room for the one non-OSS upstream.
Its code is original except where noted: EAP-Signal's prompt descends from TLDR
/ caveman (MIT), EAP-Lean's rule text and skills are a documentation derivative
of ponytail (MIT), and EAP-Context borrows graphify's `_trigrams` helper and
provenance vocabulary (MIT). All three upstream MIT notices are retained in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Zero copyleft, zero ELv2
contamination, zero supply-chain surface.
