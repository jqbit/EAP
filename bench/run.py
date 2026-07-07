#!/usr/bin/env python3
"""EAP efficiency bench — honest, reproducible, stdlib-only.

Measures how many *input* tokens each strategy places in an agent's context to
answer the fixed tasks in bench/tasks.json over the committed fixture in
bench/corpus/, and whether the checkable answer survives (task_success).

Arms
  B0  STRAWMAN  dump every corpus byte into context. Reported for context only
                and always labeled a strawman — it is NEVER the baseline.
  B1  BASELINE  a competent grep-and-read agent: context receives exactly the
                lines a corpus-wide grep for the task keyword surfaces
                (file:line:content). This is the honest baseline.
  B2  EAP       runtime-offload tasks: the store.mjs offload pointer/hint plus
                the top matching chunks from lossless FTS-style retrieval
                (layers/eap-runtime/src/store.mjs semantics reimplemented
                in-process; see notes below). context-retrieval tasks: the
                matching chunk(s) only.

Honesty rules enforced here (docs/EFFICIENCY.md)
  * Reduction is reported B2 vs B1 — never vs the B0 strawman.
  * task_success is printed next to every token count; a token win that loses
    the answer is flagged as a REGRESSION and the run exits nonzero.
  * Single membrane: these are input tokens only. Nothing here is multiplied
    with Runtime/Voice numbers, and no compounded headline is printed.
  * All B2 retrieval is LOSSLESS (exact chunks, never summaries); its recall
    on the answer-bearing chunk is exactly the task_success column. No lossy
    (LLM-summary) arm is measured because it would not be reproducible.
  * Full distribution: every task row is printed, including tasks where the
    grep baseline is cheaper than EAP. No cherry-picking.

Approximations (documented, committed)
  * Tokens are approximated as ceil(chars / 4). No exact model tokenizer
    ships with this repo; all token numbers are labeled approximate.
  * chunk() is a line-for-line port of store.mjs chunk() (split on blank
    lines, pack to <=2000 chars, hard-slice oversized paragraphs).
  * Ranking approximates SQLite FTS5 bm25 with AND-of-terms matching scored
    by total term frequency (ties broken by document order, then chunk
    index). Deterministic; no stemming.
  * The offload threshold is 16 KiB here (store.mjs offload() takes it as a
    parameter; its default is 100 KiB) so the mid-size fixtures exercise the
    offload path. Each task is scored as an independent agent episode, so the
    pointer hint is counted once per task.

Run: python3 bench/run.py   (or: make bench)
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CHUNK_MAX_CHARS = 2000  # store.mjs chunk() default


# --------------------------------------------------------------------------
# Token approximation (documented: chars/4, ceiling)
# --------------------------------------------------------------------------
def approx_tokens(text: str) -> int:
    return (len(text) + 3) // 4


# --------------------------------------------------------------------------
# store.mjs semantics, reimplemented in-process (Python port)
# --------------------------------------------------------------------------
def chunk(text: str, max_chars: int = CHUNK_MAX_CHARS) -> list[str]:
    """Port of layers/eap-runtime/src/store.mjs chunk()."""
    out: list[str] = []
    buf = ""

    def flush() -> None:
        nonlocal buf
        if buf.strip():
            out.append(buf.strip())
        buf = ""

    for para in re.split(r"\n{2,}", str(text)):
        if len(para) >= max_chars:
            flush()
            for i in range(0, len(para), max_chars):
                out.append(para[i:i + max_chars])
            continue
        if len(buf) + len(para) + 2 > max_chars:
            flush()
        buf += ("\n\n" if buf else "") + para
    flush()
    return out


def doc_id(source: str, content: str) -> str:
    """Port of store.mjs _id(): deterministic, content-addressed."""
    digest = hashlib.sha256((source + "\0" + content).encode()).hexdigest()
    return "eap_" + digest[:16]


def offload_hint(source: str, content: str, n_chunks: int) -> str:
    """The pointer message store.mjs offload() places in context."""
    nbytes = len(content.encode())
    did = doc_id(source, content)
    return (f"Indexed {n_chunks} section(s) from {source} ({nbytes} bytes kept "
            f'out of context). Query with eap_search(query, {{ docId: "{did}" }}).')


TOKEN_RE = re.compile(r"[a-z0-9]+")


def search(docs: list[dict], query: str, limit: int,
           only_doc: str | None = None) -> list[dict]:
    """Approximation of store.mjs search(): AND-of-terms lexical match over
    chunks, ranked by total term frequency (bm25 stand-in), deterministic
    tie-break by (document order, chunk index). Returns exact chunk bodies —
    lossless, never summaries."""
    terms = TOKEN_RE.findall(query.lower())
    if not terms:
        return []
    hits = []
    for d_order, doc in enumerate(docs):
        if only_doc is not None and doc["id"] != only_doc:
            continue
        for idx, body in enumerate(doc["chunks"]):
            counts = {}
            for tok in TOKEN_RE.findall(body.lower()):
                counts[tok] = counts.get(tok, 0) + 1
            if all(counts.get(t, 0) > 0 for t in terms):
                score = sum(counts[t] for t in terms)
                hits.append({"doc": doc, "idx": idx, "body": body,
                             "sort": (-score, d_order, idx)})
    hits.sort(key=lambda h: h["sort"])
    return hits[:limit]


# --------------------------------------------------------------------------
# Arms: the exact text each strategy would place in the agent's context
# --------------------------------------------------------------------------
def arm_b0(docs: list[dict]) -> str:
    """STRAWMAN: dump every corpus byte."""
    return "\n".join(f"===== {d['path']} =====\n{d['content']}" for d in docs)


def arm_b1(docs: list[dict], keyword: str) -> str:
    """Honest baseline: corpus-wide case-insensitive grep; the agent sees the
    matching lines as file:line:content, exactly like grep -rin output."""
    needle = keyword.lower()
    out = []
    for doc in docs:
        for n, line in enumerate(doc["content"].splitlines(), 1):
            if needle in line.lower():
                out.append(f"{doc['path']}:{n}:{line}")
    return "\n".join(out)


def arm_b2(docs: list[dict], task: dict, limit: int, threshold: int) -> str:
    """EAP: offload pointer + lossless chunk retrieval (runtime-offload), or
    the matching chunk(s) only (context-retrieval)."""
    parts = []
    target = next(d for d in docs if d["path"] == task["file"])
    only_doc = None
    if task["kind"] == "runtime-offload":
        if len(target["content"].encode()) > threshold:
            parts.append(offload_hint(target["path"], target["content"],
                                      len(target["chunks"])))
            only_doc = target["id"]
    for hit in search(docs, task["eap_query"], limit, only_doc=only_doc):
        parts.append(f"--- {hit['doc']['id']} chunk {hit['idx']} "
                     f"({hit['doc']['path']}) ---\n{hit['body']}")
    return "\n".join(parts)


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------
def load_corpus() -> list[dict]:
    corpus_dir = ROOT / "corpus"
    docs = []
    for path in sorted(corpus_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = "corpus/" + path.relative_to(corpus_dir).as_posix()
        content = path.read_text()
        docs.append({
            "path": rel,
            "content": content,
            "chunks": chunk(content),
            "id": doc_id(rel, content),
        })
    return docs


def pct_saved(b1: int, b2: int) -> str:
    if b1 == 0:
        return "n/a"
    return f"{(1 - b2 / b1) * 100:+.1f}%".replace("+", "")


def main() -> int:
    spec = json.loads((ROOT / "tasks.json").read_text())
    limit = spec["search_limit"]
    threshold = spec["offload_threshold_bytes"]
    docs = load_corpus()

    corpus_bytes = sum(len(d["content"].encode()) for d in docs)
    print("EAP efficiency bench — input-membrane tokens, per task")
    print(f"corpus: {len(docs)} committed files, {corpus_bytes} bytes; "
          f"{len(spec['tasks'])} fixed tasks")
    print("tokens are APPROXIMATE: ceil(chars/4); no exact model tokenizer ships here")
    print()
    print("  B0  STRAWMAN dump-all  — every corpus byte in context; shown for "
          "context only, never the baseline")
    print("  B1  HONEST BASELINE    — grep-and-read agent (matching lines only)")
    print("  B2  EAP                — offload pointer + lossless exact-chunk "
          "retrieval (store.mjs semantics)")
    print()

    header = (f"{'task':<26} {'kind':<18} {'B0*':>7} {'B1':>7} {'B2':>7} "
              f"{'B2 vs B1':>9}  {'success B0/B1/B2':>16}")
    print(header)
    print("-" * len(header))

    rows = []
    regressions = []
    for task in spec["tasks"]:
        texts = {
            "B0": arm_b0(docs),
            "B1": arm_b1(docs, task["grep_keyword"]),
            "B2": arm_b2(docs, task, limit, threshold),
        }
        toks = {k: approx_tokens(v) for k, v in texts.items()}
        ok = {k: task["expected"] in v for k, v in texts.items()}
        rows.append((task, toks, ok))
        if ok["B1"] and not ok["B2"]:
            regressions.append(task["id"])
        flags = "/".join("Y" if ok[k] else "N" for k in ("B0", "B1", "B2"))
        print(f"{task['id']:<26} {task['kind']:<18} {toks['B0']:>7} "
              f"{toks['B1']:>7} {toks['B2']:>7} "
              f"{pct_saved(toks['B1'], toks['B2']):>9}  {flags:>16}")

    sum_b0 = sum(t["B0"] for _, t, _ in rows)
    sum_b1 = sum(t["B1"] for _, t, _ in rows)
    sum_b2 = sum(t["B2"] for _, t, _ in rows)
    n = len(rows)
    ok_b1 = sum(1 for _, _, ok in rows if ok["B1"])
    ok_b2 = sum(1 for _, _, ok in rows if ok["B2"])
    ok_b0 = sum(1 for _, _, ok in rows if ok["B0"])
    print("-" * len(header))
    print(f"{'AGGREGATE':<26} {'':<18} {sum_b0:>7} {sum_b1:>7} {sum_b2:>7} "
          f"{pct_saved(sum_b1, sum_b2):>9}  "
          f"{f'{ok_b0}/{n} {ok_b1}/{n} {ok_b2}/{n}':>16}")
    print()
    print("* B0 is a STRAWMAN (dump-every-byte). It is printed for context "
          "only; no claim in this repo is measured against it.")
    print("Reduction is B2 vs B1 (the honest grep-and-read baseline). "
          "Negative rows mean grep was cheaper there — reported, not hidden.")
    print("All B2 retrieval is lossless (exact chunks + pointer, never "
          "summaries); recall of the answer-bearing chunk = the task_success "
          "column. No lossy-summary arm is measured (not reproducible "
          "without an LLM).")
    print("Single membrane: input tokens only. Per docs/EFFICIENCY.md these "
          "numbers are never multiplied with other layers' savings and no "
          "compounded headline exists.")
    print()
    print(f"task_success: B1 {ok_b1}/{n}, B2 {ok_b2}/{n} "
          f"(a B2 token win that loses the answer is a regression, not a win)")

    if regressions:
        print()
        for tid in regressions:
            print(f"REGRESSION: task '{tid}' lost its checkable answer under B2")
        return 1
    if ok_b1 < n or ok_b2 < n:
        print()
        print("FAILURE: an arm lost a checkable answer; see success column")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
