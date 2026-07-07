# bench — EAP's reproducible efficiency harness

The only numbers this repo publishes are the ones this directory reproduces.
Rules: `docs/EFFICIENCY.md`.

## Run

```bash
python3 bench/run.py     # or: make bench
```

Python 3.10+ standard library only. Zero dependencies, no network, no LLM.
The run is fully deterministic: fixed committed corpus, fixed committed task
suite, deterministic retrieval, content-addressed ids. Exit code is nonzero
if any arm loses a task's checkable answer.

## What is measured

Input-membrane tokens: the text each strategy would place in an agent's
context to answer each task in `tasks.json`, plus `task_success` — whether
the task's checkable answer string survives into that text. This harness
measures **one membrane only**. Working (Runtime) and output (Voice) savings
are not measured here and are **never multiplied** with these numbers; no
compounded headline exists anywhere in this repo.

## The corpus (committed fixture)

`corpus/` is a small synthetic fixture (~80 KB total) of the kind of material
agents otherwise dump into context. It is committed and never regenerated at
run time:

| File | ~Size | What it is |
|---|---|---|
| `corpus/access.log` | 46 KB | web access log: hot checkout traffic, a scraper, a burst of HTTP 500s, `[SLOW]` flags |
| `corpus/issues.json` | 30 KB | 65 issue records, one compact JSON object per line |
| `corpus/src/*.py` | 6 KB | small multi-file code sample (payments, inventory, notifications) |

## The arms

- **B0 — STRAWMAN dump-all.** Every corpus byte in context. This is the
  baseline upstream "99%"-class claims are measured against; here it is
  printed for context only, always labeled a strawman, and **never** used as
  the denominator for any claim.
- **B1 — honest baseline.** A competent grep-and-read agent: context receives
  exactly the lines a corpus-wide case-insensitive grep for the task's
  keyword surfaces, as `file:line:content`.
- **B2 — EAP.** For runtime-offload tasks: the `store.mjs` offload pointer
  hint plus the top matching chunks from lossless retrieval
  (`layers/eap-runtime/src/store.mjs` semantics — `chunk()`, content-addressed
  doc ids, and the offload hint are reimplemented in-process in `run.py`).
  For context-retrieval tasks: the matching chunk(s) only.

## Honesty rules this harness enforces

1. **Reduction is reported B2 vs B1**, never vs the B0 strawman.
2. **task_success is first-class**: printed beside every token count. A B2
   token win that drops the answer is flagged `REGRESSION` and fails the run.
3. **Never multiplied**: input tokens only; no cross-layer product, no
   compounded percentage, no reprint of any upstream headline number.
4. **Lossy vs lossless**: every B2 row is lossless (exact chunks + pointer,
   never summaries), and its recall of the answer-bearing chunk is exactly
   the `task_success` column. No lossy-summary arm is measured, because a
   summary would require an LLM and would not be reproducible.
5. **Full distribution**: every task row is printed, including the ones where
   grep beats EAP (rare-token needles like `[SLOW]` and `FEE_BPS`). No
   cherry-picked best rows.

## Documented approximations

- **Tokens ≈ `ceil(chars / 4)`.** No exact model tokenizer ships with this
  repo, so every token figure is labeled approximate. The approximation is
  applied identically to all arms, so the *ratios* are meaningful even where
  the absolute counts drift from any specific model's tokenizer.
- **Ranking** approximates `store.mjs`'s SQLite FTS5 bm25 with AND-of-terms
  matching scored by total term frequency (deterministic tie-breaks); no
  stemming.
- **Offload threshold** is 16 KiB here so the mid-size fixtures exercise the
  offload path; `store.mjs` `offload()` takes the threshold as a parameter
  and defaults to 100 KiB. Each task is scored as an independent agent
  episode, so the pointer hint is counted once per task.

Change any input (corpus, tasks, thresholds) and the published table must be
regenerated with `python3 bench/run.py` — reproducible or unpublished.
