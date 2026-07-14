# EAP-Lean benchmark harness

Measures what the EAP-Lean rule actually changes: two arms (no skill vs
`EAP-LEAN.md` as system prompt), three Claude models, five everyday tasks,
scored on **code LOC** (deterministic count) and **functional correctness**
(a gate — a broken one-liner fails no matter how few lines it has).

**No numbers ship with EAP.** This directory is the harness only. It makes no
LLM calls until you run it, and `results/` stays empty until you put your own
measured runs there. EAP reprints no upstream headline percentage; if you want
a number, measure it (see `results/README.md` for the schema and the honesty
rules). Structure adapted from the upstream project EAP-Lean derives from
(MIT; see `../../../docs/legal/ATTRIBUTION.md`).

## Run (Claude / GPT / Gemini, via promptfoo)

Requires the matching API key and **Node.js >= 22**:

```bash
cd layers/eap-lean/bench
export ANTHROPIC_API_KEY=sk-ant-...   # Claude
npx promptfoo@latest eval -c promptfooconfig.yaml --repeat 10

export OPENAI_API_KEY=sk-...          # GPT
npx promptfoo@latest eval -c promptfooconfig.gpt.yaml --repeat 10
npx promptfoo@latest eval -c promptfooconfig.gpt-newest.yaml --repeat 10

export GOOGLE_API_KEY=...             # Gemini
npx promptfoo@latest eval -c promptfooconfig.gemini.yaml --repeat 10

npx promptfoo@latest view
```

Use `--repeat 10` and report the **median**; single runs are noise.
**No results ship** — put measured runs in `results/` yourself.

After a real eval, regenerate example transcripts (refuses without `output.json`):

```bash
# copy promptfoo's output.json into this directory first
node generate-examples.mjs
```

## Run (agentic harness)

Headless Claude Code sessions (safety + LOC tiers). Self-test first:

```bash
cd layers/eap-lean/bench/agentic
python run.py --selftest
# live (spends API): python run.py --all --models haiku --runs 1
```

Details: [`agentic/README.md`](agentic/README.md). Empty until you run it.

## Run (local models, via Ollama)

No API key or promptfoo required:

```bash
ollama pull llama3.2
python layers/eap-lean/bench/benchmark-local.py --model llama3.2 --repeat 3
```

Writes full responses to `benchmark-local-results.json` (gitignored territory —
summarize into `results/`, don't commit raw transcripts).

## Metrics

| File | Metric | Behavior |
|------|--------|----------|
| `loc.cjs` | `code_loc` | Measurement — always passes, records non-blank non-comment LOC from fenced blocks (or the whole response if unfenced) |
| `correctness.cjs` | `correct` | Gate — fails if the generated code doesn't work |

`correctness.cjs` extracts fenced code blocks and runs per-task checks: it
**executes** the email, debounce, and CSV code (spawns Python/Node with
appended assertions) and does structural checks for the React countdown and
FastAPI rate-limit tasks (no runtime execution — those verify plausible
structure, not full correctness). Timeout per spawned check: 30 s, override
with `EAP_LEAN_CORRECTNESS_TIMEOUT_MS`.

Prerequisites for the correctness gate: **Python 3** and **Node.js** on PATH.

## Self-checks (no API key, no network)

The metric code carries its own regression guards:

```bash
node layers/eap-lean/bench/loc.test.cjs
node layers/eap-lean/bench/correctness.test.cjs   # needs python3 + node
```

## Arms

- `arms/baseline.cjs` — the bare task, no system prompt.
- `arms/eap-lean.cjs` — `../EAP-LEAN.md` verbatim as the system prompt. Single
  source of truth: the benchmark always measures the rule as shipped.

## Read your numbers honestly

- Single-shot completions against a bare model overstate the win: the baseline
  answers with several options plus commentary, so LOC counts prose-adjacent
  code, not one committed solution.
- Gains are workload-dependent: large where the model would over-build,
  near zero — or net-negative on cost — where the code is already minimal,
  because the injected rule costs input tokens every turn.
- Never turn a benchmark median into a per-repo savings claim. See
  `../../../docs/EFFICIENCY.md`.
