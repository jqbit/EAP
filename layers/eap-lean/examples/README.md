# EAP-Lean examples

Before/after pairs showing the decision ladder in action, in two flavors:

1. **Benchmark transcripts** — verbatim model output, the same task answered by
   the same model with no skill (`## Without EAP-Lean`) and with the ladder rule
   (`## With EAP-Lean`), side by side. Model: Claude Haiku 4.5, temperature 1.
2. **Ladder cards** — short hand-written before/after cases: a dependency or
   hand-rolled block on top, the stdlib/native one-liner underneath.

## Benchmark transcripts

| Example | Ladder rung | Without (LOC) | With (LOC) |
|---|---|--:|--:|
| [Email validation](email-validation.md) | shrink | 75 | 3 |
| [Debounce](debounce.md) | yagni / shrink | 116 | 10 |
| [CSV sum](csv-sum.md) | stdlib | 20 | 3 |
| [React countdown](react-countdown.md) | yagni / shrink | 267 | 9 |
| [Rate limiting](rate-limit.md) | shrink | 128 | 10 |

**Honesty note.** These transcripts come from an upstream benchmark run of the
ladder rule EAP-Lean is adapted from (MIT; see
[`../../../docs/legal/ATTRIBUTION.md`](../../../docs/legal/ATTRIBUTION.md)).
The LOC figures are counted from the transcripts themselves — you can recount
them in each file — but **EAP has not re-run the benchmark**, ships no headline
percentage, and makes no per-repo savings claim. Re-measure with your own API
key: [`../bench/`](../bench/).

## Ladder cards

| Example | Ladder rung |
|---|---|
| [Deep clone](deep-clone.md) | native — `structuredClone` over lodash |
| [Group by](group-by.md) | native — `Object.groupBy` over lodash/reduce |
| [URL params](url-params.md) | native — `URLSearchParams` over query-string |
| [Number formatting](number-formatting.md) | native — `Intl.NumberFormat` over numeral |
| [Modal dialog](modal-dialog.md) | native — `<dialog>` over a modal lib |
| [Infinite scroll](infinite-scroll.md) | native — `IntersectionObserver` over a scroll lib |

Deliberate simplifications inside the code use the EAP-Lean comment convention:

`// eap-lean: <ceiling> — upgrade path: <how>`
