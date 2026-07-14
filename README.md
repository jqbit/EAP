<h1 align="center">EAP — Efficient Agent Protocol</h1>

<p align="center"><em>Justify every token — in, through, and out.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/coupling-none%20(hard%20freeze)-111111?style=flat-square" alt="No upstream coupling">
  <img src="https://img.shields.io/badge/claims-reproducible%20only-111111?style=flat-square" alt="Honest claims">
</p>

EAP compresses an AI coding agent's token usage at **all three points of the
token lifecycle** — plus the code it writes — where every other tool addresses
only one:

- **EAP-Context** trims the tokens that flow **in** (retrieval): query a local
  code-symbol graph (10 languages, path/community/centrality, incremental index)
  and get `file:line` pointers instead of dumping whole files.
- **EAP-Runtime** trims the tokens that accrete **during** the turn (tool
  output): "think in code" — run a script (12 languages), return only its
  summary; auto-index oversized output behind a searchable pointer; the only
  network egress is the SSRF-hardened `eap_fetch`.
- **EAP-Signal** trims the tokens that flow **out** (prose): verdict-first
  answers that keep code, paths, and safety text byte-exact.
- **EAP-Lean** trims the **code** the agent writes: a 7-rung minimal-code ladder
  with hard safety carve-outs.

One installer, one hook dispatcher, one skill format, four disciplines.

## Status

| Layer | State | Notes |
|---|---|---|
| **EAP-Signal** | **shipping** | The perfected TLDR prompt/skill. Prompt-only, so it applies to any agent; the installer writes it **natively** for Claude Code + the native roster below (see `--list`). |
| **EAP-Lean** | **shipping** | Minimal-code craft (ponytail MIT derivative): 7-rung ladder + safety carve-outs, prompt-only, installed alongside Signal (`--no-lean` to skip); mode + review/audit/debt/gain/help skills. |
| **EAP-Runtime** | **built** (clean-room) | 13-tool MCP server: polyglot executor (12 languages), dual-tokenizer RRF FTS offload store, SSRF-hardened `eap_fetch`/`fetch_and_index`, `execute_file`/`batch_execute`/`doctor`/`purge`, session event log + snapshot/restore. |
| **EAP-Context** | **built** (stdlib-only) | Symbol-graph engine, 10 languages (Python `ast` + regex for JS/TS/Go/Rust/Java/C/C++/C#/Ruby/PHP), 8 MCP tools incl. shortest-path/communities/centrality, fuzzy seeding, incremental index. 52 Python tests (`npm run test:py`). |
| **Installer** | **built** | `bin/eap-install.mjs` — wires Signal + Lean (+ skills/commands where the host supports them) and both MCP servers. **End-to-end: Claude Code** (incl. `/eap-update` command + `eap-update` skill). **Native Signal+Lean+MCP+skills:** codex, grok, hermes, cursor, antigravity, opencode (+ slash commands/agents, incl. `/eap-update`). **Native Signal+Lean (+ skills):** pi, windsurf; **rules only:** cline (`~/Documents/Cline/Rules` — no global skills dir without marketplace IDs). **Gemini:** local extension context (`GEMINI.md`) under `~/.gemini/extensions/eap` — skills not staged (extension API is context-only). **Planned:** Copilot (no stable global instructions path), continue/kilo/roo/augment (`npx skills add` profile IDs). See `--list`. |
| **Bench** | **built** | Deterministic harness over a committed 82 KB corpus; 6 fixed tasks, B2 vs honest grep baseline B1: 37.3% aggregate token reduction, task success 6/6 (`npm run bench`). |

See `docs/ARCHITECTURE.md` for the full design and `EAP.md` for the protocol.

## Install

**One line — macOS / Linux / Git Bash / WSL:**

```bash
curl -fsSL https://raw.githubusercontent.com/0point9bar/EAP/main/install.sh | bash
```

**One line — Windows PowerShell:**

```powershell
irm https://raw.githubusercontent.com/0point9bar/EAP/main/install.ps1 | iex
```

Either bootstrap checks git + Node ≥ 22, clones the repo, and launches an
**interactive TUI** — it auto-detects your installed agents and lets you pick
which agents and which layers (Signal / Runtime / Context) to wire. The TUI
reads from your terminal even through `curl | bash`. To skip the prompts in
automation, append flags: `… | bash -s -- --only claude --non-interactive`.

> The bare `curl`/`irm` one-liner requires the `0point9bar/EAP` repo to be **public**
> (raw URLs and anonymous `git clone` don't work on private repos). Until then,
> clone it yourself and run the installer directly (below).

**From a local clone (works private):**

```bash
node bin/eap.mjs install                          # interactive TUI (default on a terminal)
node bin/eap-install.mjs                          # same via legacy bin
node bin/eap.mjs list                             # provider matrix: end-to-end vs planned
node bin/eap.mjs install --dry-run --only claude  # print the full plan, write nothing
node bin/eap.mjs install --only claude            # wire EAP into Claude Code (non-interactive)
node bin/eap.mjs uninstall                        # remove Signal block + MCP entries + hooks
```

## Updating

```bash
eap update                     # fetch origin, ff-only branch (or latest release tag if detached)
eap update --check             # current vs remote; no apply
eap update --dry-run           # print plan only
eap update --ref v0.2.0        # pin a tag or branch
eap update --force --ref main  # hard reset (explicit --force only)
```

Also: `node bin/eap.mjs update` / `node bin/eap-install.mjs update`. Slash
`/eap-update` (Claude Code + opencode commands) and the `eap-update` skill
(Claude + every native host with a skills dir, when runtime skills are on).

Checkout resolution: `$EAP_HOME` → `~/.eap/src` → this repo if it is an EAP git
checkout → else clone `https://github.com/0point9bar/EAP.git` to `~/.eap/src`.
After git refresh, re-runs `eap-install --non-interactive` and writes
`~/.eap/install-state.json`. MCP `eap_upgrade` stays plan-only without checksums;
the CLI applies because you typed `eap update`.

For **Claude Code** the installer is end-to-end. It:

1. writes the **EAP-Signal** and **EAP-Lean** rules as managed, marker-fenced
   blocks into `<config-dir>/CLAUDE.md` (stripped cleanly on `--uninstall`, user
   content preserved; `--no-lean` skips the Lean block);
2. registers both MCP servers — **eap-runtime** (`node …/eap-runtime/src/mcp.mjs`) and
   **eap-context** (`python3 …/eap_context/mcp.py <project-root>`) — via `claude mcp add`
   when the CLI is present, else by writing the `.mcp.json` `mcpServers` entry. Each is
   optional and independently installable (`--no-runtime`, `--no-context`);
3. wires the hook dispatcher (`src/hooks/eap-dispatch.mjs`) into
   `<config-dir>/settings.json` for **SessionStart / PreToolUse / PostToolUse / PreCompact**.

Beyond Claude Code, the installer also wires **native** agents:

- **codex, grok, hermes, cursor, antigravity, opencode** — Signal + Lean rules, Signal+Lean+Runtime
  **skills** (incl. `eap-update`), and both **EAP MCP servers** (CLI or JSON). opencode also gets
  slash **commands** (incl. `/eap-update`) and eapcrew **agents**. cursor rules land in
  `~/.cursor/rules/eap.mdc` (`alwaysApply`).
- **pi** — Signal + Lean rules + skills (no MCP; Pi uses npm extensions).
- **windsurf** — `~/.windsurf/rules/eap.md` + skills; **cline** — rules only at
  `~/Documents/Cline/Rules/eap.md` (skills need marketplace profile IDs).
- **gemini** — context extension under `~/.gemini/extensions/eap` from
  `layers/eap-signal/gemini-extension.json` (+ `gemini extensions install` when CLI on PATH);
  no skills staging (extension is context-file only).

**Still planned** (honest reason): **Copilot** — no stable global instructions path (per-repo
`.github/copilot-instructions.md` or marketplace skills CLI only); **continue / kilo / roo /
augment** and other `npx skills add` hosts — need marketplace profile IDs (ELv2-free adapter
would invent paths those hosts ignore). `--list` is authoritative. Zero third-party deps.

## Honest efficiency

EAP **does not** reprint its sources' 99%-class headline numbers — those are
measured against strawman "dump every byte" baselines. EAP publishes only what
its committed `bench/` harness reproduces against a **realistic** grep-and-read
baseline, reports **task success** alongside token counts, and separates lossy
from lossless retrieval with recall. Details: `docs/EFFICIENCY.md`.

## Ownership

MIT, sole-maintained, self-contained. EAP-Signal descends from TLDR ← caveman
(MIT). EAP-Lean is derived from the MIT-licensed ponytail project (rule/docs/
examples/bench ports; hook runtime reimplemented under `src/hooks/`).
EAP-Runtime is original / clean-room. EAP-Context is concept-derived from
MIT-licensed graphify (stdlib-only, no graphify code or dependencies used;
notice retained). The Elastic-Licensed context-mode project (behind EAP-Runtime)
is clean-room-reimplemented from concept only — **zero source used**. Full
provenance: `docs/legal/ATTRIBUTION.md`.

## Layout

```text
EAP/
├── EAP.md                     # the protocol
├── layers/eap-signal/          # output prose compression (shipping — perfected TLDR)
├── layers/eap-lean/            # output code compression (ponytail-concept ladder)
├── layers/eap-runtime/        # working/tool-output offload (clean-room)
├── layers/eap-context/        # input/retrieval symbol graph (stdlib, concept-derived)
├── docs/                      # ARCHITECTURE, EFFICIENCY, legal/
├── bench/                     # honest, reproducible efficiency harness
├── scripts/check-contamination.sh   # ELv2 clean-room guard (CI gate)
└── tests/
```
