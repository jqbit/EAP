# EAP Architecture

EAP is one product with three compression gates across the token lifecycle,
riding a single distribution spine.

## The three membranes

```
        ┌──────────────────────────────────────────────────────────┐
        │                      AGENT TURN                           │
        │                                                          │
  files │  EAP-Context      working ctx   EAP-Runtime    prose out │
  repos ─┼─▶ graph route ─▶  reasoning  ─▶ exec offload ─▶ Signal ──┼─▶ user
  docs  │   (pointers)                     (summaries)   (verdict) │
        │       ▲                              ▲             ▲     │
        └───────┼──────────────────────────────┼─────────────┼─────┘
                │        one .eap/ project root, one hook dispatcher
                └──────── local, deterministic, no-LLM / no-network ───────┘
```

- **Input membrane (EAP-Context).** Before reasoning, the agent asks the local
  code-symbol graph for the relevant subgraph and receives `file:line` pointers.
  It opens only what it needs. No whole-file dumps.
- **Working membrane (EAP-Runtime).** During the turn, tool output is processed
  by a script in a subprocess; only the printed summary returns to context.
  Output over a size threshold is auto-indexed locally and replaced with a
  searchable pointer. State persists across compaction.
- **Output membrane (EAP-Signal).** After reasoning, prose is compressed
  verdict-first; code, paths, and safety text are preserved byte-exact.

## Shared substrate

- **One project root:** `.eap/` holds the graph cache, the blob/session index
  (SQLite/FTS), and the per-layer flag files.
- **One hook dispatcher:** a single event fan-out (generalized from TLDR's
  `src/hooks/` stack):
  - `SessionStart` → inject Signal rules + Runtime resume snapshot + Context
    graph-availability note.
  - `PreToolUse` → Context graph-nudge (prefer a graph query over a raw read).
  - `PostToolUse` → Runtime offload of oversized tool output.
  - `PreCompact` → Runtime state snapshot so nothing is lost at compaction.
- **One installer spine:** TLDR's `bin/install.js` `PROVIDERS[]` matrix (35
  agents). EAP-Context and EAP-Runtime contribute **skills + MCP-server
  registrations**, not new installers. The `tldr-shrink` MCP registration in
  TLDR is the precedent; EAP ships up to two optional MCP servers (a Node
  runtime server and a graph server), each independently installable.
- **One skill format:** the `SKILL.md` frontmatter shape and the
  `plugins/` mirror discipline, reused and renamed.

## Layer ownership & overlap resolution

| Concern | Resolution |
|---|---|
| Retrieval overlap (graph vs blob index) | One front door routes by query shape: code-symbol queries → graph; blob/log/doc queries → lexical index. No functional duplication. |
| Storage overlap (graph JSON vs SQLite) | One `.eap/` root, two purpose-built stores. The graph keeps its materialized JSON cache; SQLite is the blob + session substrate. No premature DB merge. |
| Hook overlap (3 stacks) | One dispatcher fans out per event (above). |
| Installer overlap (3 multi-host installers) | TLDR's provider matrix is the single spine; the others contribute skills + MCP registrations only. |
| Philosophy tension (Runtime writes more code; Signal writes less prose) | Different membranes, not a conflict: Runtime spends a few working tokens on a script to save far more tool-output tokens; Signal then compresses the final answer. |

## Correctness guarantees

- Every layer is **independently opt-out** and ships a **lossless escape hatch**
  (open the real file; return the full blob; disable Signal).
- The bench harness measures **task success**, not just tokens; a layer that
  lowers success is treated as a regression.
- Offload is **opt-in per size threshold**; small outputs pass through verbatim.

## Security posture (honest)

The Runtime executor is a subprocess with a **policy** deny-list (blocks
`curl`/`wget`/inline network fetches and redirects them to an indexed fetch),
**not** OS-level isolation. It inherits the host's credentials by design. This
is labeled as a policy control, not a sandbox. Real isolation (bwrap/landlock/
containers) is an explicit later layer, not an implied guarantee.

Within that policy layer we still **fail closed**:

- `eap_execute_file` cannot read a file → it refuses to run it
  (`policy-scan-failed`), rather than running an unscanned file.
- `eap_fetch` egress is scheme-allowlisted (http/https), **port**-allowlisted
  (80/443 only — a non-default port such as `:6379` is `port-blocked`), and
  **strips URL credentials** so no `Authorization: Basic` header is derived or
  leaked; every rule is re-applied on each redirect hop, alongside the existing
  SSRF IP guard.
- The clean-room contamination gate treats a scan **error** (grep exit ≥2) as a
  hard failure, not a silent pass.
