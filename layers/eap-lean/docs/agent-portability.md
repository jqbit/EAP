# Agent Portability

EAP-Lean is an agent-portable skill + rule distribution. The skills in
`layers/eap-lean/skills/` hold the core behavior; host-specific install paths
(via `bin/eap-install.mjs` and always-on rule files) are adapters that make that
behavior load in a given agent.

Adapted from ponytail's host×file matrix (MIT, © Dietrich Gebert) and rewritten
for EAP's multi-layer installer. Full provenance:
[`../../../docs/legal/ATTRIBUTION.md`](../../../docs/legal/ATTRIBUTION.md).

## Supported adapters (EAP)

| Host | How EAP lands Lean | Notes |
|------|--------------------|-------|
| Claude Code | `CLAUDE.md` managed `<!-- eap-lean:begin -->` block + `~/.claude/skills/eap-lean*` + hooks via `settings.json` | Full end-to-end: SessionStart, UserPromptSubmit (`/eap lean`), **SubagentStart**, Pre/PostToolUse, PreCompact, Stop; statusline; `commandWindows` for PowerShell. |
| Codex | `~/.codex/AGENTS.md` Signal-native path; skills discoverable when staged | Instruction-tier for Lean body when installed into AGENTS.md; hooks share Claude/Codex patterns where the host supports them. |
| Cursor | Project rules / MCP (`~/.cursor/mcp.json`); Lean via project `AGENTS.md` or `.cursor/rules` when staged | Per-repo instruction-tier; no global always-on Lean file from the installer today. |
| OpenCode | `$XDG_CONFIG_HOME/opencode/AGENTS.md` (+ MCP jsonc) | Signal-native path; stage Lean rule / skills into AGENTS.md or skills dir. |
| Hermes | `$HERMES_HOME/SOUL.md` + `hermes mcp add` | Signal-native; Lean as SOUL/skills port. |
| Gemini CLI | Detected; planned full wiring | Copy `EAP-LEAN.md` into Gemini context / skills; do not claim hook parity until wired. |
| pi / Grok | Native Signal AGENTS.md paths | Stage Lean rule alongside Signal. |
| Windsurf / Cline / Copilot / Antigravity / Zed / Amp / Jules / Junie / Kiro / Qoder / Swival / CodeWhale | Instruction-tier via `AGENTS.md` or host rule file | Copy `layers/eap-lean/EAP-LEAN.md` (or the compact skill) into the host's always-on path. See installer `PROVIDERS` roster in `bin/eap-install.mjs`. |
| Generic agents | `EAP-LEAN.md` or `skills/*/SKILL.md` | Drop the rule file or load skills directly. |

## Adapter rule

Keep adapters thin. Prefer pointing the host at existing
`layers/eap-lean/skills/` and the shared dispatcher
(`src/hooks/eap-dispatch.mjs`) rather than forking rule text. When a host only
supports project instructions, keep its copy aligned with `EAP-LEAN.md`.

## Portable behavior (six Lean skills)

| Skill | Path | Role |
|-------|------|------|
| Mode switch | `skills/eap-lean/SKILL.md` | `/eap lean lite\|full\|ultra\|off` for skill-only hosts |
| Review | `skills/eap-lean-review/SKILL.md` | Over-engineering review → delete-list |
| Audit | `skills/eap-lean-audit/SKILL.md` | Repo-wide lean audit |
| Debt | `skills/eap-lean-debt/SKILL.md` | Harvest `eap-lean:` markers |
| Gain | `skills/eap-lean-gain/SKILL.md` | Measured-only scoreboard |
| Help | `skills/eap-lean-help/SKILL.md` | Quick reference |

Always-on compact rule: `EAP-LEAN.md` (installed into the agent's memory/rules
file behind `<!-- eap-lean:begin -->` … `<!-- eap-lean:end -->`).

## Defaults & subagent scoping

| Knob | Effect |
|------|--------|
| `EAP_LEAN_DEFAULT_MODE` / `EAP_SIGNAL_DEFAULT_MODE` | New-session default (`off\|lite\|full\|ultra` [+ wenyan for Signal]) |
| `~/.config/eap/config.json` (`leanDefaultMode` / `defaultMode`, `signalDefaultMode`) | Same, file-backed (`%APPDATA%\eap\config.json` on Windows) |
| Project `.eap/config.json` | Project override of the above |
| `/eap lean default <mode>` | Persist lean default via hooks |
| `EAP_SUBAGENT_MATCHER` | Regex on `agent_type` — skip **all** SubagentStart inject on mismatch |
| `EAP_LEAN_SUBAGENT_MATCHER` | Regex — skip **Lean** inject only |

Unset matcher → inject every subagent. Invalid regex or missing `agent_type` →
fail-open (inject).
