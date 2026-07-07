# EAP — Efficient Agent Protocol

**Justify every token — in, through, and out.**

EAP is one protocol with three compression gates across the token lifecycle of
an AI coding agent. Each gate sits at a *membrane* — a boundary tokens cross —
and every crossing is a cost to justify:

| Phase | Membrane (what crosses) | EAP layer | Mechanism |
|---|---|---|---|
| **Input / retrieval** | reference material loaded *into* context before reasoning | **EAP-Context** | code-symbol graph routing + lexical blob index → inject a small subgraph and `file:line` pointers instead of dumping files |
| **Working / tool** | tool output accreting *during* the turn (logs, API blobs, stdout) | **EAP-Runtime** | "think in code": run a script in a subprocess, return only summary stdout; auto-offload large output into a local index behind a searchable pointer; persist state across compaction |
| **Output / generation** | model prose emitted *back* to the user | **EAP-Voice** | verdict-first prose; cut filler while preserving code, paths, and safety-critical text |

The three are **one product**, not three plugins, because they share a
substrate: a local, deterministic, **no-LLM / no-network** index rooted under a
single `.eap/` project directory, and a **single hook + skill + installer**
distribution stack inherited from TLDR.

## Prime directive

Answer correctly. Never trade away correctness, tool use, code, reasoning, or
safety to save tokens. Efficiency that lowers task success is a regression, not
a win. Every layer keeps a **lossless escape hatch** and is **independently
opt-out**.

## The three layers

### EAP-Voice (output) — active by default
Verdict-first response style. Cuts filler, preamble, hedging, and validation
while keeping code, commands, errors, paths, and safety text byte-exact. Six
intensity levels (lite / full / ultra plus three Classical-Chinese *wenyan*
tiers). This layer is the perfected TLDR prompt; it is prompt-only and needs no
runtime. See `layers/eap-voice/`.

### EAP-Context (input) — opt-in
A local code-symbol graph (Python-stdlib `ast` for Python plus lightweight
regex extractors for JS/TS/Go → symbol graph with provenance). Instead of
loading whole files, the agent queries the graph for the relevant subgraph and
receives `file:line` pointers it opens on
demand. Deterministic, no LLM, no network. See `layers/eap-context/`.

### EAP-Runtime (working) — opt-in
A "think in code" execution offload: the agent writes a script that runs in a
subprocess against raw data; only the script's printed summary re-enters
context. Output above a size threshold is auto-indexed into a local store and
replaced with a searchable pointer. Session state is persisted so it survives
compaction. Independent **cleanroom reimplementation** of the context-offload
pattern (see `docs/legal/ATTRIBUTION.md`). See `layers/eap-runtime/`.

## Composition rules

- Gains are **additive across independent membranes** — input reduced by graph
  routing, working reduced by execution offload, output reduced by voice.
- Gains are **measured and reported separately per layer**. They are **never
  multiplied** into a single compounded headline number.
- Every reduction claim is reproducible from the committed `bench/` harness
  against a **realistic** baseline (a grep-and-read agent), not a strawman
  "dump every byte" baseline. See `docs/EFFICIENCY.md`.

## Honesty

EAP reprints **none** of its source projects' headline percentages. Upstream
"99%"-class figures are measured against strawman dump-everything baselines and
are not reproduced here. EAP publishes only what its own committed harness can
reproduce, reports task success alongside token counts, and separates lossy
from lossless retrieval with recall. See `docs/EFFICIENCY.md`.

## Ownership & licensing

MIT, sole-maintained, self-contained, with zero upstream runtime coupling and
**zero third-party code or dependencies**. Every layer is original / clean-room
code. EAP-Context is an independent Python-stdlib symbol-graph engine
**concept-derived from the MIT-licensed graphify project — no graphify code or
dependencies used**. The Elastic-Licensed context-mode project is
**clean-room-reimplemented from concept only — zero source is used**. Full posture:
`docs/legal/ATTRIBUTION.md` and `NOTICE`.
