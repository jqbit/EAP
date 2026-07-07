<h1 align="center">EAP — Efficient Agent Protocol</h1>

<p align="center"><em>Justify every token — in, through, and out.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/coupling-none%20(hard%20freeze)-111111?style=flat-square" alt="No upstream coupling">
  <img src="https://img.shields.io/badge/claims-reproducible%20only-111111?style=flat-square" alt="Honest claims">
</p>

EAP compresses an AI coding agent's token usage at **all three points of the
token lifecycle**, where every other tool addresses only one:

- **EAP-Context** trims the tokens that flow **in** (retrieval): query a local
  code-symbol graph and get `file:line` pointers instead of dumping whole files.
- **EAP-Runtime** trims the tokens that accrete **during** the turn (tool
  output): "think in code" — run a script, return only its summary; auto-index
  oversized output behind a searchable pointer.
- **EAP-Voice** trims the tokens that flow **out** (prose): verdict-first
  answers that keep code, paths, and safety text byte-exact.

One installer, one hook dispatcher, one skill format, three compression gates.

## Status

| Layer | State | Notes |
|---|---|---|
| **EAP-Voice** | **shipping** | The perfected TLDR prompt/skill, prompt-only, works on 35+ agents today. |
| **EAP-Runtime** | **built** (clean-room) | Executor ("think in code"), session event log + snapshot/restore, offload store, JSON-RPC 2.0 stdio MCP server. |
| **EAP-Context** | **built** (stdlib-only) | Symbol-graph engine (Python `ast` + JS/TS extraction), query with pointers, CLI + stdio MCP server. 9 Python tests green (`npm run test:py`). |
| **Installer** | **built** | `bin/eap-install.mjs` — one command wires all three layers (Voice rule + both MCP servers + hook dispatcher). **End-to-end for Claude Code today**; the other 34 agents in the roster are detected and given an honest manual plan (`--list`). 47 node tests green (`npm test`). |
| **Bench** | **built** | Deterministic harness over a committed 82 KB corpus; 6 fixed tasks, B2 vs honest grep baseline B1: 37.3% aggregate token reduction, task success 6/6 (`npm run bench`). |

See `docs/ARCHITECTURE.md` for the full design and `EAP.md` for the protocol.

## Install

**One line — macOS / Linux / Git Bash / WSL:**

```bash
curl -fsSL https://raw.githubusercontent.com/jqbit/EAP/main/install.sh | bash
```

**One line — Windows PowerShell:**

```powershell
irm https://raw.githubusercontent.com/jqbit/EAP/main/install.ps1 | iex
```

Either bootstrap checks git + Node ≥ 22, clones the repo, and launches an
**interactive TUI** — it auto-detects your installed agents and lets you pick
which agents and which layers (Voice / Runtime / Context) to wire. The TUI
reads from your terminal even through `curl | bash`. To skip the prompts in
automation, append flags: `… | bash -s -- --only claude --non-interactive`.

> The bare `curl`/`irm` one-liner requires the `jqbit/EAP` repo to be **public**
> (raw URLs and anonymous `git clone` don't work on private repos). Until then,
> clone it yourself and run the installer directly (below).

**From a local clone (works private):**

```bash
node bin/eap-install.mjs                          # interactive TUI (default on a terminal)
node bin/eap-install.mjs --list                   # provider matrix: end-to-end vs planned
node bin/eap-install.mjs --dry-run --only claude  # print the full plan, write nothing
node bin/eap-install.mjs --only claude            # wire EAP into Claude Code (non-interactive)
node bin/eap-install.mjs --uninstall              # remove Voice block + MCP entries + hooks
```

For **Claude Code** the installer is end-to-end. It:

1. writes the **EAP-Voice** rule as a managed, marker-fenced block into
   `<config-dir>/CLAUDE.md` (stripped cleanly on `--uninstall`, user content preserved);
2. registers both MCP servers — **eap-runtime** (`node …/eap-runtime/src/mcp.mjs`) and
   **eap-context** (`python3 …/eap_context/mcp.py <project-root>`) — via `claude mcp add`
   when the CLI is present, else by writing the `.mcp.json` `mcpServers` entry. Each is
   optional and independently installable (`--no-runtime`, `--no-context`);
3. wires the hook dispatcher (`src/hooks/eap-dispatch.mjs`) into
   `<config-dir>/settings.json` for **SessionStart / PreToolUse / PostToolUse / PreCompact**.

Every **other** provider (Gemini, Cursor, Windsurf, opencode, Codex, …34 total) is
**detected and reported as `planned`** — the installer prints a per-agent manual plan and
does **not** claim to have wired an agent it has not implemented end-to-end. Zero
third-party dependencies: Node built-ins only.

## Honest efficiency

EAP **does not** reprint its sources' 99%-class headline numbers — those are
measured against strawman "dump every byte" baselines. EAP publishes only what
its committed `bench/` harness reproduces against a **realistic** grep-and-read
baseline, reports **task success** alongside token counts, and separates lossy
from lossless retrieval with recall. Details: `docs/EFFICIENCY.md`.

## Ownership

MIT, sole-maintained, self-contained. EAP-Voice and EAP-Runtime are original /
clean-room code; EAP-Context is concept-derived from MIT-licensed graphify
(stdlib-only, no graphify code or dependencies used; notice retained). The
Elastic-Licensed context-mode project is clean-room-reimplemented from concept
only — **zero source used**. Full provenance: `docs/legal/ATTRIBUTION.md`.

## Layout

```text
EAP/
├── EAP.md                     # the protocol
├── layers/eap-voice/          # output compression (shipping — perfected TLDR)
├── layers/eap-runtime/        # working/tool-output offload (clean-room)
├── layers/eap-context/        # input/retrieval symbol graph (stdlib, concept-derived)
├── docs/                      # ARCHITECTURE, EFFICIENCY, legal/
├── bench/                     # honest, reproducible efficiency harness
├── scripts/check-contamination.sh   # ELv2 clean-room guard (CI gate)
└── tests/
```
