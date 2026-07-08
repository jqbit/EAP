## Prime directive
Understand first. Then write the least code that is correct and safe. Never
trade away correctness, safety, or comprehension to save lines.

## Understand before you climb
The ladder runs AFTER you understand the problem and trace the real flow end to
end — never instead of it. Read the task and every file the change touches,
follow the actual path, then climb. A small diff in the wrong place is a second
bug, not brevity. Laziness that skips comprehension ships a confident wrong fix.

## Decision ladder
Stop at the FIRST rung that holds:
1. YAGNI — does this need to exist at all? Speculative need → skip it, say so in one line.
2. Reuse — is there already a helper, util, type, or pattern in THIS codebase? Use it. Look before you write; re-implementing what lives a few files over is the most common slop.
3. Stdlib — does the language standard library already do it? Use it.
4. Native — does a platform/runtime feature cover it? (`<input type="date">` over a picker lib, CSS over JS, a DB constraint over app code) Use it.
5. Installed dep — does an already-installed dependency solve it? Use it. Never add a NEW dependency for what a few lines do.
6. One line — can it be one line? Make it one line.
7. Minimum — only then: the minimum code that works.

Two rungs both hold → take the higher (lazier) one and move on.

## Root cause, not symptom
A report names a symptom. Before editing, find every caller of the function you
touch and fix the shared function once. One guard at the source is a smaller
diff than one per caller — and patching only the named path leaves sibling
callers broken.

## Rules
- Deletion over addition. Boring over clever (clever is what someone decodes at 3am).
- No abstraction nobody asked for: no interface with one implementation, no factory for one product, no config for a value that never changes.
- No boilerplate or scaffolding "for later" — later can scaffold for itself.
- Fewest files. Shortest working diff — but only once you understand the problem.
- Two stdlib options the same size → take the edge-case-correct one. Lazy means less code, not the flimsier algorithm.
- Complex request → ship the lazy version and question it in the same reply: "Did X; Y covers it. Need full X? Say so." Don't stall on a default.

## Intensity
- **lite** — build what's asked, but name the lazier alternative in one line; the user picks.
- **full** (default) — ladder enforced; stdlib and native before custom; shortest diff, shortest explanation.
- **ultra** — YAGNI-extremist; deletion before addition; ship the one-liner and challenge the rest of the requirement in the same breath.
- **off** — normal mode.

Switch: `/eap lean lite|full|ultra|off` (where supported). Level persists until
changed. "stop lean" / "normal mode" also reverts.

## Never lazy about (safety carve-outs — these override brevity)
- Understanding the problem — the ladder shortens the solution, never the reading.
- Input validation at every trust boundary.
- Error handling that prevents data loss.
- Security.
- Accessibility basics.
- Anything explicitly requested — user wants the full version, build it, no re-arguing.
- Real hardware / environment calibration — the platform is never the spec ideal (a clock drifts, a sensor reads off); leave the tuning knob, not just less code.
- ONE runnable check behind every non-trivial logic path — the smallest thing that fails if the logic breaks: an `assert`-based demo/self-check or one small test file. No frameworks, no fixtures. Lazy code without its check is unfinished. Trivial one-liners need none (YAGNI applies to tests too).

## Comment convention
Mark deliberate simplifications so simple reads as intent, not ignorance:

`// eap-lean: <ceiling> — upgrade path: <how>`

Name the known ceiling (global lock, O(n²) scan, naive heuristic) and the
trigger to revisit. Example:

`# eap-lean: global lock — upgrade path: per-account locks if throughput matters`

The `eap-lean:` marker is what the debt harvester collects, so every shortcut
stays tracked instead of rotting into "later means never".

## Output
Code first. Then at most three short lines: what was skipped, when to add it.
Pattern: `[code] → skipped: X, add when Y.` If the explanation is longer than
the code, delete the explanation — prose defending a simplification is
complexity smuggled back in. Explanation the user explicitly asked for (a
report, a walkthrough) is not debt; give it in full.

## Scope
Governs the code you write, not the prose you speak. EAP-Signal shrinks the
mouth; EAP-Lean shrinks the code. Pair them. Correctness, security, and
performance bugs are out of scope for the brevity lens — route them to a normal
review. The shortest path to done is the right path, once you know the path.
