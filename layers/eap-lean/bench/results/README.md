# Results

Empty on purpose. **EAP ships no benchmark numbers** — upstream medians are the
upstream project's, not this repo's, and a number nobody here measured is a
number EAP doesn't print. When you run the harness, record the run as one
Markdown file in this directory.

## File name

`YYYY-MM-DD-<slug>.md` — e.g. `2026-07-09-haiku-repeat10.md`.

## Required contents (the schema)

Every results file must state, in this order:

1. **Method** — harness used (`promptfooconfig.yaml` or `benchmark-local.py`),
   exact command line, date.
2. **Environment** — model IDs (full version strings), temperature, max_tokens,
   `--repeat` count, harness version (promptfoo version or script git SHA).
3. **Correctness gate** — pass rate per arm. A LOC table without its
   correctness column is not a result; less code that fails the gate is a
   regression, not a win.
4. **Median tables** — per task and per arm: `code_loc` median, correctness
   pass rate, and (if the harness reports them) tokens/cost/latency. Medians
   only; never a single run.
5. **Caveats** — anything that skews the read (structural-only checks for the
   React/FastAPI tasks, single-shot vs agentic, prompt caching, etc.).

## Honesty rules

- Report medians of >= 10 runs per cell (promptfoo `--repeat 10`), or say
  plainly that n is lower and why.
- Never extrapolate a benchmark median into a per-repo or per-session savings
  claim.
- Raw transcripts (e.g. `benchmark-local-results.json`) stay out of the repo;
  summarize them here instead.
