# Agentic benchmark (EAP-Lean)

Port/adapt of ponytail's agentic harness (MIT, © Dietrich Gebert — see
`../../../../docs/legal/ATTRIBUTION.md`). Measures real headless Claude Code
sessions editing a seeded workspace — not single-shot chat completions.

**No measured results ship with EAP.** `runs/` is local/gitignored territory.
Do not paste upstream %-savings into EAP docs.

## Arms

| Arm | System prompt |
|-----|----------------|
| `baseline` | none |
| `eap-lean` | `layers/eap-lean/EAP-LEAN.md` (appended) |
| `yagni` | `"Follow YAGNI principles."` |
| `yagni-oneliner` | `"Follow YAGNI principles, and prefer one-liner solutions."` |

## Run

Self-test scorers first (no API):

```bash
cd layers/eap-lean/bench/agentic
python run.py --selftest
```

Live matrix (spends API; requires `claude` CLI + Anthropic auth):

```bash
python run.py --all --models haiku --runs 1
# workspaces + metrics under runs/<stamp>/
python run.py --rescore runs/<stamp>
```

Optional LLM judges (over-engineering / completeness):

```bash
python judge.py --selftest-offline   # gate logic only
python complete.py --selftest-offline
# live scoring needs ANTHROPIC_API_KEY — see scripts for flags
```

## Relation to single-shot promptfoo

| | `../promptfooconfig*.yaml` | this |
|---|---|---|
| Unit | one completion | Claude Code session |
| Correctness | execute / structure gate | safety tier + LOC tier |
| Models | Claude / GPT / Gemini configs | Claude CLI models |

Also see `../README.md` for GPT/Gemini promptfoo twins and
`../generate-examples.mjs` (needs a real `output.json` — refuses to invent).
