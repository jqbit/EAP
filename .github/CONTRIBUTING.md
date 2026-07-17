# Contributing to EAP

Thanks for considering a contribution. **EAP (Efficient Agent Protocol)**
compresses an AI coding agent's tokens at all three membranes of the token
lifecycle — input, working, and output — as one self-contained, honest,
zero-dependency product.

EAP is the "parent" build-out of the [TLDR](https://github.com/0p9b/TLDR)
philosophy: TLDR is the minimal-invasion output-only child; EAP embeds TLDR as
its Signal layer and adds two more. Keep changes small and focused; a tight PR
beats a big rewrite.

---

## The three layers

| Layer | Membrane | What it is | Source |
|---|---|---|---|
| **EAP-Signal** | output | verdict-first prose (the TLDR ruleset) — prompt-only, always-on | `layers/eap-signal/EAP-SIGNAL.md` |
| **EAP-Runtime** | working | "think in code": run a script in a subprocess, return only summary stdout; auto-offload big output behind a searchable pointer | `layers/eap-runtime/src/*.mjs` |
| **EAP-Context** | input | local code-symbol graph → inject a subgraph + `file:line` pointers instead of whole files | `layers/eap-context/src/eap_context/*.py` |

The three share one substrate: a local, deterministic, **no-LLM / no-network**
index under a single `.eap/` directory, distributed by one installer + hook +
skill stack inherited from TLDR.

## Non-negotiables

- **Zero third-party dependencies.** Node built-ins (`node:sqlite`,
  `node:child_process`, `node:readline`, …) and the Python standard library
  (`ast`, `re`, `json`) only. `scripts/check-contamination.sh` and CI enforce
  this. No `dependencies` block in `package.json`.
- **Honest claims.** Every reduction number is reproducible from the committed
  `bench/` harness against a realistic grep-and-read baseline — never a
  strawman "dump every byte" baseline, never a compounded headline. See
  `docs/EFFICIENCY.md`.
- **Correctness first.** Never trade task success for tokens. Every layer keeps
  a lossless escape hatch and is independently opt-out.
- **Clean-room provenance.** The ELv2-licensed `context-mode` project is
  concept-only (no source). graphify/ponytail are concept-derived, MIT-credited,
  no code taken. See `docs/legal/ATTRIBUTION.md` and `NOTICE`.
- **Security fixes carry a regression test** that fails pre-fix.

## What to edit (sources of truth)

| Change | Edit |
|---|---|
| Signal output rules | `layers/eap-signal/EAP-SIGNAL.md` |
| Runtime executor / store / MCP | `layers/eap-runtime/src/{executor,store,session,mcp}.mjs` |
| Context extractor / graph / query / MCP | `layers/eap-context/src/eap_context/{extract,graph,query,mcp}.py` |
| Installer + provider wiring | `bin/eap-install.mjs` |
| Hook dispatcher | `src/hooks/eap-dispatch.mjs` |
| Protocol overview | `EAP.md`, layer `DESIGN.md`s |

## Adding an agent

`bin/eap-install.mjs` carries a `PROVIDERS` table. EAP-Signal installs natively
into an agent's global rules file (the same AGENTS.md-convention paths TLDR
uses); the Runtime + Context MCP servers register with MCP-capable agents.
Wire a new agent by adding its rules-file path and MCP-config mechanism — do
not invent a new code path per agent.

## Running the gates locally

```bash
npm test                                   # node --test tests/*.test.mjs
python3 tests/test_context_engine.py       # context engine (stdlib)
python3 bench/run.py                        # honest benchmark
bash scripts/check-contamination.sh         # clean-room guard
node bin/eap-install.mjs --list             # provider matrix
node bin/eap-install.mjs --dry-run --only claude
```

All must be green before a PR merges (CI runs them on Node 22 and 24).
