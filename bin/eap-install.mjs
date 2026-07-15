#!/usr/bin/env node
// EAP — unified installer. Wires all three EAP layers into an AI coding agent in
// one command:
//
//   1. EAP-Signal   — the always-on output-compression rule, written as a managed
//                    marker-fenced block into the agent's memory file (Claude
//                    Code: <configDir>/CLAUDE.md).
//   2. EAP-Runtime — the working-memory offload MCP server (node), registered
//                    into the agent's MCP config. Optional (--no-runtime).
//   3. EAP-Context — the code-symbol-graph MCP server (python3), registered into
//                    the agent's MCP config. Optional (--no-context).
//   + the EAP hook dispatcher (src/hooks/eap-dispatch.mjs) wired into the agent's
//     hook settings (SessionStart / PreToolUse / PostToolUse / PreCompact).
//
// Zero third-party dependencies — Node built-ins only. Structure and the JSONC
// settings merge are adapted from the MIT-licensed TLDR installer (same author).
//
// End-to-end today: Claude Code. Every other provider in the roster is detected
// and reported HONESTLY as "planned" — the installer never claims to have wired
// an agent it did not touch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import {
  readSettings, writeSettings, validateHookFields,
  addCommandHook, removeCommandHooks,
  upsertFencedBlock, stripFencedBlock, atomicWrite, isPlainObject,
} from './lib/settings.mjs';
import { writeInstallState } from './lib/update.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// bin/eap-install.mjs -> repo root is one level up.
const REPO_ROOT = path.resolve(__dirname, '..');

// Absolute paths to the two MCP server entrypoints and the signal rule + hook.
const RUNTIME_MCP = path.join(REPO_ROOT, 'layers', 'eap-runtime', 'src', 'mcp.mjs');
const CONTEXT_MCP = path.join(REPO_ROOT, 'layers', 'eap-context', 'src', 'eap_context', 'mcp.py');
const SIGNAL_RULE = path.join(REPO_ROOT, 'layers', 'eap-signal', 'EAP-SIGNAL.md');
const LEAN_RULE = path.join(REPO_ROOT, 'layers', 'eap-lean', 'EAP-LEAN.md');
const LEAN_SKILLS_SRC = path.join(REPO_ROOT, 'layers', 'eap-lean', 'skills');
const LEAN_SKILLS = ['eap-lean', 'eap-lean-review', 'eap-lean-audit', 'eap-lean-debt', 'eap-lean-gain', 'eap-lean-help'];
const RUNTIME_SKILLS_SRC = path.join(REPO_ROOT, 'layers', 'eap-runtime', 'skills');
const RUNTIME_SKILLS = [
  'eap-stats', 'eap-search', 'eap-doctor', 'eap-purge',
  'eap-runtime', 'eap-index', 'eap-upgrade', 'eap-update',
];
const SIGNAL_SKILLS_SRC = path.join(REPO_ROOT, 'layers', 'eap-signal', 'skills');
const SIGNAL_SKILLS = [
  'eap-signal', 'eap-signal-commit', 'eap-signal-review', 'eap-signal-stats',
  'eap-signal-compress', 'eap-signal-help', 'eapcrew',
];
const SIGNAL_AGENTS_SRC = path.join(REPO_ROOT, 'layers', 'eap-signal', 'agents');
const SIGNAL_AGENTS = ['eapcrew-investigator.md', 'eapcrew-builder.md', 'eapcrew-reviewer.md'];
const SIGNAL_COMMANDS_SRC = path.join(REPO_ROOT, 'layers', 'eap-signal', 'commands');
const SIGNAL_SHRINK = path.join(REPO_ROOT, 'layers', 'eap-signal', 'mcp-servers', 'eap-signal-shrink', 'index.mjs');
const HOOK_DISPATCH = path.join(REPO_ROOT, 'src', 'hooks', 'eap-dispatch.mjs');
const STATUSLINE = path.join(REPO_ROOT, 'src', 'hooks', 'eap-statusline.mjs');
const STATUSLINE_PS1 = path.join(REPO_ROOT, 'src', 'hooks', 'eap-statusline.ps1');

// Managed-block markers (Signal rule) and the hook idempotency marker.
const SIGNAL_BEGIN = '<!-- eap-signal:begin -->';
const SIGNAL_END = '<!-- eap-signal:end -->';
// Legacy markers from before the EAP-Voice → EAP-Signal rename. Still recognized
// on UNINSTALL so an install made by an older build is cleaned up; never written.
const LEGACY_SIGNAL_BEGIN = '<!-- eap-voice:begin -->';
const LEGACY_SIGNAL_END = '<!-- eap-voice:end -->';

// Managed-block markers for the always-on EAP-Lean (minimal-code craft) rule. It
// is a peer of Signal: a second fenced block in the SAME rules file, upserted and
// stripped independently. No legacy markers exist — Lean shipped as eap-lean from
// the start.
const LEAN_BEGIN = '<!-- eap-lean:begin -->';
const LEAN_END = '<!-- eap-lean:end -->';

// Strip the current AND legacy Signal managed blocks from a rules-file body.
function stripSignalBlocks(body) {
  let touched = false;
  let r = stripFencedBlock(body, SIGNAL_BEGIN, SIGNAL_END);
  touched = touched || r.stripped;
  r = stripFencedBlock(r.text, LEGACY_SIGNAL_BEGIN, LEGACY_SIGNAL_END);
  touched = touched || r.stripped;
  return { text: r.text, stripped: touched };
}

// Strip EVERY EAP-managed block (Signal + legacy Signal, then Lean) from a
// rules-file body — the uninstall counterpart of writeRulesBlocks. Returns
// { text, stripped } with `stripped` true if either discipline's block was
// present. Surrounding user content is preserved by stripFencedBlock.
function stripEapBlocks(body) {
  let r = stripSignalBlocks(body);
  const signalStripped = r.stripped;
  const lean = stripFencedBlock(r.text, LEAN_BEGIN, LEAN_END);
  return { text: lean.text, stripped: signalStripped || lean.stripped };
}
const HOOK_MARKER = 'eap-dispatch';

// Claude Code hook events EAP wires (see src/hooks/eap-dispatch.mjs).
// SubagentStart injects Signal+Lean into Task-spawned agents (parent SessionStart
// context does not reach them — ponytail #252).
const HOOK_EVENTS = [
  { event: 'SessionStart', matcher: null, timeout: 10 },
  { event: 'UserPromptSubmit', matcher: null, timeout: 5 },
  { event: 'SubagentStart', matcher: null, timeout: 10 },
  { event: 'PreToolUse', matcher: 'Read|Grep|Glob', timeout: 5 },
  { event: 'PostToolUse', matcher: null, timeout: 10 },
  { event: 'PreCompact', matcher: null, timeout: 10 },
  { event: 'Stop', matcher: null, timeout: 5 },
];

// PowerShell companion for Claude Code's commandWindows field. Paths are
// single-quoted (PS literal); doubled singles escape. Never use cmd %VAR%.
function psCommandWindows(node, script, ...args) {
  const q = (p) => `'${String(p).replace(/'/g, "''")}'`;
  const rest = args.map(q).join(' ');
  return `if (Get-Command node -ErrorAction SilentlyContinue) { & ${q(node)} ${q(script)}${rest ? ' ' + rest : ''} }`;
}

// ── Provider roster ─────────────────────────────────────────────────────────
// The id/label/detect matrix mirrored from the TLDR installer, reused as the
// EAP roster (37 rows). `wired: true` = end-to-end (Claude). `native` = Signal+Lean
// rules (and optional skills/commands/MCP) written natively — reported as
// "signal + lean[+mcp]", never "end-to-end".
//
// native fields:
//   signal       — always-on rules file ($HOME / $XDG_CONFIG_HOME / $HERMES_HOME)
//   frontmatter  — optional IDE header prepended on first create (cursor/windsurf)
//   skills       — skills root dir (Signal+Lean SKILL.md trees copied here)
//   commands     — slash-command dir (opencode)
//   agents       — eapcrew agent defs (opencode)
//   mcp          — Runtime/Context MCP registration (see installMcpNative)
//   kind         — 'gemini-ext' uses `gemini extensions install` (local layer path)
//
// Copilot stays planned: no stable global instructions path (per-repo
// .github/copilot-instructions.md or marketplace skills CLI only).
const PROVIDERS = [
  { id: 'claude',     label: 'Claude Code',        detect: 'command:claude', wired: true },
  { id: 'gemini',     label: 'Gemini CLI',         detect: 'command:gemini', native: { kind: 'gemini-ext' } },
  { id: 'opencode',   label: 'opencode',           detect: 'command:opencode', native: {
      signal: '$XDG_CONFIG_HOME/opencode/AGENTS.md',
      skills: '$XDG_CONFIG_HOME/opencode/skills',
      commands: '$XDG_CONFIG_HOME/opencode/commands',
      agents: '$XDG_CONFIG_HOME/opencode/agents',
      mcp: { kind: 'json', file: '$XDG_CONFIG_HOME/opencode/opencode.jsonc', key: 'mcp', shape: 'command-array-local' },
    } },
  { id: 'openclaw',   label: 'OpenClaw',           detect: 'command:openclaw||dir:$HOME/.openclaw/workspace' },
  { id: 'hermes',     label: 'Hermes Agent',       detect: 'command:hermes', native: {
      signal: '$HERMES_HOME/SOUL.md',
      skills: '$HERMES_HOME/skills/productivity',
      mcp: { kind: 'cli-hermes', bin: 'hermes' },
    } },
  { id: 'codex',      label: 'Codex CLI',          detect: 'command:codex', native: {
      signal: '$HOME/.codex/AGENTS.md',
      skills: '$HOME/.codex/skills',
      mcp: { kind: 'cli-dashdash', bin: 'codex' },
    } },
  { id: 'pi',         label: 'Pi Coding Agent',    detect: 'command:pi', native: {
      signal: '$HOME/.pi/agent/AGENTS.md',
      skills: '$HOME/.pi/agent/skills',
    } },
  { id: 'grok',       label: 'Grok Build CLI',     detect: 'command:grok', native: {
      signal: '$HOME/.grok/AGENTS.md',
      skills: '$HOME/.grok/skills',
      mcp: { kind: 'cli-dashdash', bin: 'grok' },
    } },
  // oh-my-pi: loads a user-scope AGENTS.md and auto-discovers skills + mcp.json
  // from its agent dir. Default dir ~/.omp/agent (profile-scoped to
  // ~/.omp/profiles/<name>/agent only when OMP_PROFILE/PI_PROFILE is set).
  { id: 'omp',        label: 'oh-my-pi',           detect: 'command:omp', native: {
      signal: '$HOME/.omp/agent/AGENTS.md',
      skills: '$HOME/.omp/agent/skills',
      mcp: { kind: 'json', file: '$HOME/.omp/agent/mcp.json', key: 'mcpServers', shape: 'command-args' },
    } },
  // Cursor has no GLOBAL always-on rules file: ~/.cursor/rules/*.mdc (alwaysApply)
  // only takes effect when cwd is $HOME or a repo carrying its own .cursor/rules.
  // For real repos, run `eap-signal-init` (per-repo rule). Detect cursor-agent too.
  { id: 'cursor',     label: 'Cursor',             detect: 'command:cursor-agent||command:cursor||macapp:Cursor', native: {
      signal: '$HOME/.cursor/rules/eap.mdc',
      frontmatter: '---\ndescription: "EAP — Signal (verdict-first) + Lean (minimal-code)"\nalwaysApply: true\n---\n\n',
      skills: '$HOME/.cursor/skills',
      mcp: { kind: 'json', file: '$HOME/.cursor/mcp.json', key: 'mcpServers', shape: 'command-args' },
    } },
  { id: 'windsurf',   label: 'Windsurf',           detect: 'command:windsurf||macapp:Windsurf', native: {
      signal: '$HOME/.windsurf/rules/eap.md',
      frontmatter: '---\ntrigger: always_on\n---\n\n',
      skills: '$HOME/.windsurf/skills',
    } },
  { id: 'cline',      label: 'Cline',              detect: 'vscode-ext:cline', native: {
      // Rules only: Cline global skills go through `npx skills add` marketplace
      // profiles — no stable MIT-compatible skills dir to copy into.
      signal: '$HOME/Documents/Cline/Rules/eap.md',
    } },
  // planned: marketplace `npx skills add` profile IDs (continue/kilo/roo/augment).
  { id: 'continue',   label: 'Continue',           detect: 'vscode-ext:continue.continue||vscode-ext:continue' },
  { id: 'kilo',       label: 'Kilo Code',          detect: 'vscode-ext:kilocode' },
  { id: 'roo',        label: 'Roo Code',           detect: 'vscode-ext:roo||vscode-ext:rooveterinaryinc.roo-cline||cursor-ext:roo' },
  { id: 'augment',    label: 'Augment Code',       detect: 'vscode-ext:augment||jetbrains-plugin:augment' },
  // planned: no stable global instructions file (per-repo .github/copilot-instructions.md
  // or marketplace `npx skills add` only — no global adapter we can ship).
  { id: 'copilot',    label: 'GitHub Copilot',     detect: 'command:copilot', soft: true },
  { id: 'aider-desk', label: 'Aider Desk',         detect: 'command:aider' },
  { id: 'amp',        label: 'Sourcegraph Amp',    detect: 'command:amp' },
  { id: 'bob',        label: 'IBM Bob',            detect: 'command:bob' },
  { id: 'crush',      label: 'Crush',              detect: 'command:crush' },
  { id: 'devin',      label: 'Devin (terminal)',   detect: 'command:devin' },
  { id: 'droid',      label: 'Droid (Factory)',    detect: 'command:droid' },
  { id: 'forgecode',  label: 'ForgeCode',          detect: 'command:forge' },
  { id: 'goose',      label: 'Block Goose',        detect: 'command:goose' },
  { id: 'iflow',      label: 'iFlow CLI',          detect: 'command:iflow' },
  { id: 'kiro',       label: 'Kiro CLI',           detect: 'command:kiro' },
  { id: 'mistral',    label: 'Mistral Vibe',       detect: 'command:mistral' },
  { id: 'openhands',  label: 'OpenHands',          detect: 'command:openhands' },
  { id: 'qwen',       label: 'Qwen Code',          detect: 'command:qwen' },
  { id: 'rovodev',    label: 'Atlassian Rovo Dev', detect: 'command:rovodev' },
  { id: 'tabnine',    label: 'Tabnine CLI',        detect: 'command:tabnine' },
  { id: 'trae',       label: 'Trae',               detect: 'command:trae' },
  { id: 'warp',       label: 'Warp',               detect: 'command:warp' },
  { id: 'replit',     label: 'Replit Agent',       detect: 'command:replit' },
  { id: 'junie',      label: 'JetBrains Junie',    detect: 'jetbrains-plugin:junie', soft: true },
  { id: 'qoder',      label: 'Qoder',              detect: 'dir:$HOME/.qoder', soft: true },
  { id: 'antigravity',label: 'Google Antigravity', detect: 'command:agy||dir:$HOME/.gemini/antigravity', soft: true, native: {
      signal: '$HOME/.gemini/config/AGENTS.md',
      skills: '$HOME/.gemini/config/skills',
      mcp: { kind: 'json', file: '$HOME/.gemini/config/mcp_config.json', key: 'mcpServers', shape: 'command-args' },
    } },
];

// ── argv ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    help: false, listOnly: false, dryRun: false, uninstall: false,
    nonInteractive: false, noColor: false, force: false,
    runtime: true, context: true, lean: true, tui: false, yes: false,
    withMcpShrink: null, // null=off; string=upstream argv string after --with-mcp-shrink=
    only: [], configDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '--list': opts.listOnly = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--uninstall': case '-u': opts.uninstall = true; break;
      case '--non-interactive': opts.nonInteractive = true; break;
      case '--no-color': opts.noColor = true; break;
      case '--force': opts.force = true; break;
      case '--no-runtime': opts.runtime = false; break;
      case '--no-context': opts.context = false; break;
      case '--no-lean': opts.lean = false; break;
      case '--tui': opts.tui = true; break;
      case '-y': case '--yes': opts.yes = true; break;
      case '--no-mcp-shrink': opts.withMcpShrink = null; break;
      case '--': break;
      case '--only': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) die('error: --only requires an agent id (see --list)');
        // Accept both comma lists (`--only a,b`) and repeated flags (`--only a
        // --only b`), mirroring the TLDR installer. Trim + drop empties so a
        // stray comma (`--only a,`) doesn't inject a blank id.
        const ids = v.split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => (s === 'aider' ? 'aider-desk' : s));
        if (ids.length === 0) die('error: --only requires at least one agent id (see --list)');
        opts.only.push(...ids);
        break;
      }
      case '--config-dir': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) die('error: --config-dir requires a path');
        opts.configDir = expandHome(v);
        break;
      }
      default: {
        // --with-mcp-shrink="<upstream cmd…>" or --with-mcp-shrink <upstream>
        if (a === '--with-mcp-shrink' || a.startsWith('--with-mcp-shrink=')) {
          let v = a.includes('=') ? a.slice('--with-mcp-shrink='.length) : argv[++i];
          if (!v || v.startsWith('--')) die('error: --with-mcp-shrink requires an upstream command');
          // Strip surrounding quotes from shell forms.
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          opts.withMcpShrink = v.trim();
          break;
        }
        die(`error: unknown flag: ${a}\nrun 'eap-install --help' for usage`);
      }
    }
  }
  if (opts.only.length) {
    const known = new Set(PROVIDERS.map((p) => p.id));
    for (const id of opts.only) {
      if (!known.has(id)) die(`error: unknown agent: ${id}\n  see 'eap-install --list' for valid ids`);
    }
  }
  return opts;
}

function die(msg) { process.stderr.write(msg + '\n'); process.exit(2); }
function expandHome(p) { return p.replace(/^\$HOME/, os.homedir()).replace(/^~/, os.homedir()); }

// ── color ───────────────────────────────────────────────────────────────────
function makeChalk(noColor) {
  const useColor = !noColor && process.stdout.isTTY && !process.env.NO_COLOR;
  const wrap = (codes) => (s) => (useColor ? `\x1b[${codes}m${s}\x1b[0m` : s);
  return { cyan: wrap('36'), dim: wrap('2'), red: wrap('31'), green: wrap('32'), yellow: wrap('33') };
}

// ── detection (ported from the TLDR installer) ──────────────────────────────
const IS_WIN = process.platform === 'win32';

function shellEscape(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function hasCmd(cmd) {
  try {
    if (IS_WIN) return child_process.spawnSync('where', [cmd], { stdio: 'ignore' }).status === 0;
    return child_process.spawnSync('sh', ['-c', `command -v ${shellEscape(cmd)}`], { stdio: 'ignore' }).status === 0;
  } catch { return false; }
}
function safeStat(p, method) { try { return fs.statSync(p)[method](); } catch { return false; } }
function macAppPresent(name) {
  if (process.platform !== 'darwin') return false;
  return [`/Applications/${name}.app`, path.join(os.homedir(), 'Applications', `${name}.app`)].some((p) => fs.existsSync(p));
}
function extPresent(needle, roots) {
  const re = new RegExp(needle, 'i');
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    let entries; try { entries = fs.readdirSync(r); } catch { continue; }
    if (entries.some((e) => re.test(e))) return true;
  }
  return false;
}
function vscodeExtPresent(needle) {
  const home = os.homedir();
  return extPresent(needle, [
    path.join(home, '.vscode/extensions'), path.join(home, '.vscode-server/extensions'),
    path.join(home, '.cursor/extensions'), path.join(home, '.windsurf/extensions'),
  ]);
}
function cursorExtPresent(needle) { return extPresent(needle, [path.join(os.homedir(), '.cursor/extensions')]); }
function walkDir(root, depth) {
  const out = [];
  if (depth < 0) return out;
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) if (e.isDirectory()) { const full = path.join(root, e.name); out.push(full); out.push(...walkDir(full, depth - 1)); }
  return out;
}
function jetbrainsPluginPresent(needle) {
  const home = os.homedir();
  const re = new RegExp(needle, 'i');
  for (const r of [path.join(home, 'Library/Application Support/JetBrains'), path.join(home, '.config/JetBrains')]) {
    if (!fs.existsSync(r)) continue;
    if (walkDir(r, 4).some((p) => re.test(path.basename(p)))) return true;
  }
  return false;
}
function detectMatch(spec) {
  if (!spec) return false;
  for (const clause of spec.split('||')) {
    const c = clause.trim(); if (!c) continue;
    const colon = c.indexOf(':');
    const kind = colon === -1 ? c : c.slice(0, colon);
    const val = colon === -1 ? '' : expandHome(c.slice(colon + 1));
    let ok = false;
    switch (kind) {
      case 'command': ok = hasCmd(val); break;
      case 'dir': ok = safeStat(val, 'isDirectory'); break;
      case 'file': ok = safeStat(val, 'isFile'); break;
      case 'macapp': ok = macAppPresent(val); break;
      case 'vscode-ext': ok = vscodeExtPresent(val); break;
      case 'cursor-ext': ok = cursorExtPresent(val); break;
      case 'jetbrains-plugin': ok = jetbrainsPluginPresent(val); break;
    }
    if (ok) return true;
  }
  return false;
}

// ── MCP server descriptors ──────────────────────────────────────────────────
// The exact commands EAP registers. eap-context is registered WITHOUT a pinned
// project-root arg: mcp.py defaults its root to "." (the agent's runtime cwd —
// the project it is actually working in), which is correct for both a global
// native registration AND Claude Code's global <configDir>/.mcp.json. Pinning
// the install-time cwd would wrongly lock a machine-wide registration to
// whatever directory the installer happened to run in.
function mcpServers(opts) {
  const out = {};
  if (opts.runtime) out['eap-runtime'] = { type: 'stdio', command: 'node', args: [RUNTIME_MCP] };
  if (opts.context) out['eap-context'] = { type: 'stdio', command: 'python3', args: [CONTEXT_MCP] };
  return out;
}

// Guarded write: run an fs write and return null on success, or the error
// message on failure — instead of throwing. Lets one unwritable target (a
// read-only / EROFS / EACCES / ENOENT config or rules dir, where atomicWrite's
// mkdtempSync throws) record a clean per-agent failure so the multi-agent run
// continues to the next provider rather than aborting on a raw stack trace.
function tryWrite(fn) {
  try { fn(); return null; }
  catch (e) { return (e && e.message) || String(e); }
}

// ── EAP-Signal managed block ──────────────────────────────────────────────────
// Single source of truth for the Signal block body: the heading + the verbatim
// EAP-SIGNAL.md rule. Shared by installClaude (CLAUDE.md) and installSignalNative
// (codex/opencode/pi/grok/antigravity/hermes rules files). Returns null (and
// warns) if the rule file cannot be read.
function buildSignalBody(warn) {
  try { return '# EAP-Signal — verdict-first output\n\n' + fs.readFileSync(SIGNAL_RULE, 'utf8').trimEnd(); }
  catch (e) { if (typeof warn === 'function') warn(`  cannot read Signal rule (${SIGNAL_RULE}): ${e.message}`); return null; }
}

// Single source of truth for the always-on EAP-Lean block body: the heading +
// the verbatim EAP-LEAN.md rule. Mirrors buildSignalBody. Returns null (and
// warns) if the rule file cannot be read.
function buildLeanBody(warn) {
  try { return '# EAP-Lean — minimal-code craft\n\n' + fs.readFileSync(LEAN_RULE, 'utf8').trimEnd(); }
  catch (e) { if (typeof warn === 'function') warn(`  cannot read Lean rule (${LEAN_RULE}): ${e.message}`); return null; }
}

// Upsert the EAP always-on managed blocks (Signal, and — unless --no-lean — Lean)
// into a rules/memory file in ONE symlink-safe atomic write. Each discipline
// lives behind its own fenced markers in the same file, so the two upsert
// independently and idempotently. A null body for a discipline skips it. Returns
// null on success or the error message on failure (via tryWrite), so a read-only
// rules dir records a clean per-agent failure instead of aborting the whole run.
function writeRulesBlocks(file, signalBody, leanBody, frontmatter) {
  return tryWrite(() => {
    let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (body == null) body = frontmatter || '';
    else if (frontmatter && !body.startsWith('---') && !body.includes(SIGNAL_BEGIN) && !body.includes(LEAN_BEGIN)) {
      // Prepend IDE frontmatter only when the file has neither our markers nor YAML.
      body = frontmatter + body;
    }
    if (signalBody != null) body = upsertFencedBlock(body, SIGNAL_BEGIN, SIGNAL_END, signalBody);
    if (leanBody != null) body = upsertFencedBlock(body, LEAN_BEGIN, LEAN_END, leanBody);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    // atomicWrite (temp + rename) is symlink-safe: it never writes through a
    // planted rules-file symlink, unlike fs.writeFileSync.
    atomicWrite(file, body, 0o644);
  });
}

// Resolve an env-aware path sentinel to an absolute path. Honors
// $XDG_CONFIG_HOME (env or ~/.config), $HERMES_HOME (env or ~/.hermes), and
// $HOME/~. Shared by resolveNativeSignal (rules files) and installMcpNative (MCP
// config files) so both read the same environment consistently.
function resolveSentinelPath(spec) {
  if (spec == null) return null;
  if (spec.startsWith('$XDG_CONFIG_HOME')) {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, spec.slice('$XDG_CONFIG_HOME'.length).replace(/^[\\/]+/, ''));
  }
  if (spec.startsWith('$HERMES_HOME')) {
    const base = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
    return path.join(base, spec.slice('$HERMES_HOME'.length).replace(/^[\\/]+/, ''));
  }
  return expandHome(spec);
}

// Resolve a provider's native EAP-Signal rules-file path. Returns null when the
// provider has no rules file (gemini-ext, or signal omitted).
function resolveNativeSignal(prov) {
  const spec = prov.native && prov.native.signal;
  if (!spec) return null;
  return resolveSentinelPath(spec);
}

// Copy SKILL.md trees into <skillsRoot>/<name>/. skillsRoot IS the skills
// directory (e.g. ~/.codex/skills or ~/.hermes/skills/productivity).
function installSkillsInto(skillsRoot, opts, srcRoot, names) {
  try {
    for (const name of names) {
      const srcDir = path.join(srcRoot, name);
      const src = path.join(srcDir, 'SKILL.md');
      if (!fs.existsSync(src)) continue;
      const destDir = path.join(skillsRoot, name);
      if (opts.dryRun) continue;
      fs.mkdirSync(destDir, { recursive: true });
      atomicWrite(path.join(destDir, 'SKILL.md'), fs.readFileSync(src, 'utf8'), 0o644);
      const sec = path.join(srcDir, 'SECURITY.md');
      if (fs.existsSync(sec)) {
        atomicWrite(path.join(destDir, 'SECURITY.md'), fs.readFileSync(sec, 'utf8'), 0o644);
      }
      for (const sub of ['references', 'scripts']) {
        const subSrc = path.join(srcDir, sub);
        if (!fs.existsSync(subSrc) || !fs.statSync(subSrc).isDirectory()) continue;
        copyDirRecursive(subSrc, path.join(destDir, sub));
      }
    }
    return null;
  } catch (e) { return e.message; }
}

function installSkills(configDir, opts, srcRoot, names) {
  return installSkillsInto(path.join(configDir, 'skills'), opts, srcRoot, names);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else if (ent.isFile()) {
      const buf = fs.readFileSync(s);
      // Strip accidental NUL bytes from copied sources.
      const text = buf.includes(0) ? buf.filter((b) => b !== 0).toString('utf8') : buf.toString('utf8');
      atomicWrite(d, text, 0o644);
    }
  }
}

// Strip Claude's YAML-array `tools:` frontmatter when writing eapcrew agents
// into opencode. opencode requires `tools` as an object map (or the field
// omitted) and rejects the array form — one such file makes the WHOLE opencode
// config invalid, so no MCP/skills/agents load at all. Omitting it lets opencode
// use its defaults while the agent prompt body still self-restricts. `model:` is
// a valid opencode field and is left intact (matches TLDR's bin/lib/opencode-
// agent.js, whose tests deliberately preserve it). Claude keeps the array as-is.
function stripOpencodeAgentTools(content) {
  const FENCE = '---\n';
  if (typeof content !== 'string' || !content.startsWith(FENCE)) return content;
  const fmEnd = content.indexOf('\n---', FENCE.length);
  if (fmEnd < 0) return content;
  const fm = content.slice(FENCE.length, fmEnd);
  const rest = content.slice(fmEnd);
  const out = [];
  let dropping = false;
  for (const line of fm.split('\n')) {
    if (dropping) { if (/^[ \t]/.test(line)) continue; dropping = false; }
    if (/^tools[ \t]*:/.test(line)) { dropping = true; continue; }
    out.push(line);
  }
  return FENCE + out.join('\n') + rest;
}

function installAgentsInto(destDir, opts, transform) {
  try {
    if (!fs.existsSync(SIGNAL_AGENTS_SRC)) return null;
    if (opts.dryRun) return null;
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of SIGNAL_AGENTS) {
      const src = path.join(SIGNAL_AGENTS_SRC, name);
      if (!fs.existsSync(src)) continue;
      let text = fs.readFileSync(src, 'utf8');
      if (transform) text = transform(text);
      atomicWrite(path.join(destDir, name), text, 0o644);
    }
    return null;
  } catch (e) { return e.message; }
}

function installAgents(configDir, opts) {
  return installAgentsInto(path.join(configDir, 'agents'), opts);
}

function installCommandsInto(destDir, opts) {
  try {
    if (!fs.existsSync(SIGNAL_COMMANDS_SRC)) return null;
    if (opts.dryRun) return null;
    fs.mkdirSync(destDir, { recursive: true });
    for (const ent of fs.readdirSync(SIGNAL_COMMANDS_SRC, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!/\.(md|toml)$/.test(ent.name)) continue;
      atomicWrite(
        path.join(destDir, ent.name),
        fs.readFileSync(path.join(SIGNAL_COMMANDS_SRC, ent.name), 'utf8'),
        0o644,
      );
    }
    return null;
  } catch (e) { return e.message; }
}

function installCommands(configDir, opts) {
  return installCommandsInto(path.join(configDir, 'commands'), opts);
}

// Register eap-signal-shrink wrapping an upstream MCP command string.
function installMcpShrink(ctx) {
  const { opts, configDir, note, ok, warn, results } = ctx;
  if (!opts.withMcpShrink) return;
  if (!fs.existsSync(SIGNAL_SHRINK)) {
    warn('  eap-signal-shrink entry missing — skip --with-mcp-shrink');
    return;
  }
  // Split upstream on whitespace (simple; quote-aware not required for typical `npx pkg path`).
  const upstreamArgs = opts.withMcpShrink.match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/^"|"$/g, ''));
  const entry = {
    command: process.execPath,
    args: [SIGNAL_SHRINK, ...upstreamArgs],
  };
  const mcpPath = path.join(configDir, '.mcp.json');
  const useCli = !ctx.configDirExplicit && hasCmd('claude');
  if (opts.dryRun) {
    note(`  MCP shrink: would register eap-signal-shrink → ${opts.withMcpShrink}`);
    return;
  }
  if (useCli) {
    const r = child_process.spawnSync(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'eap-signal-shrink', '--', entry.command, ...entry.args],
      { encoding: 'utf8' },
    );
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if ((r.status || 0) === 0 || /already exists/i.test(out)) {
      ok('  MCP eap-signal-shrink registered via claude mcp add');
      return;
    }
    warn(`  claude mcp add eap-signal-shrink failed: ${(out.trim().split('\n')[0] || '').slice(0, 120)}`);
  }
  const cfg = readSettings(mcpPath);
  if (cfg === null || !isPlainObject(cfg)) {
    warn('  could not write eap-signal-shrink into .mcp.json');
    results.failed.push(['mcp-shrink', 'mcp file unusable']);
    return;
  }
  if (!isPlainObject(cfg.mcpServers)) cfg.mcpServers = {};
  cfg.mcpServers['eap-signal-shrink'] = entry;
  backupOnce(mcpPath);
  writeSettings(mcpPath, cfg);
  ok(`  MCP eap-signal-shrink registered in ${mcpPath}`);
}

// Remove installer-placed skills; leave any user files in those dirs.
function uninstallSkills(configDir, opts, names) {
  let removed = 0;
  for (const name of names) {
    const dir = path.join(configDir, 'skills', name);
    if (!fs.existsSync(dir)) continue;
    if (opts.dryRun) { removed++; continue; }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

function installClaude(ctx) {
  const { opts, configDir, say, note, ok, warn, results } = ctx;
  const claudeMd = path.join(configDir, 'CLAUDE.md');
  const settingsPath = path.join(configDir, 'settings.json');
  const mcpPath = path.join(configDir, '.mcp.json');
  const eapConfPath = path.join(configDir, '.eap.json');
  const servers = mcpServers(opts);
  const serverNames = Object.keys(servers);
  const node = process.execPath;
  // MCP mechanism: prefer `claude mcp add` when the CLI is present AND we are
  // targeting the default config location; when the user pins --config-dir (or
  // the CLI is absent) write the .mcp.json entry directly so the install is
  // self-contained and reproducible.
  const useCli = !ctx.configDirExplicit && hasCmd('claude');

  say('→ Claude Code — installing all three EAP layers');

  // 1. Always-on rules: Signal + (unless --no-lean) Lean.
  const signalBody = buildSignalBody(warn);
  const leanBody = opts.lean ? buildLeanBody(warn) : null;

  if (opts.dryRun) {
    note(`  [1/3] Signal: write managed ${SIGNAL_BEGIN} block into ${claudeMd}`);
    if (opts.lean) note(`  [1/3] Lean: write managed ${LEAN_BEGIN} block into ${claudeMd}`);
    note(`  [2/3] MCP: register ${serverNames.join(' + ') || '(none — both disabled)'} via ${useCli ? '`claude mcp add`' : `${mcpPath} mcpServers`}`);
    for (const [name, s] of Object.entries(servers)) note(`         ${name}: ${s.command} ${s.args.join(' ')}`);
    note(`  [3/3] Hooks: wire ${HOOK_EVENTS.map((h) => h.event).join(', ')} into ${settingsPath}`);
    note(`         command: "${node}" "${HOOK_DISPATCH}" <Event> "${eapConfPath}"`);
    note(`  would write layer flags to ${eapConfPath}`);
    results.dryRun.push('claude');
    return;
  }

  // 1. Signal + Lean always-on rules → CLAUDE.md (managed marker-fenced blocks,
  // one symlink-safe atomic write). The write is guarded so a read-only configDir
  // records a clean failure and MCP/hooks are still attempted rather than aborting
  // the whole multi-agent run with a stack trace.
  if (signalBody != null || leanBody != null) {
    const err = writeRulesBlocks(claudeMd, signalBody, leanBody);
    if (err) { warn(`  [1/3] rules write failed (${claudeMd}): ${err}`); results.failed.push(['claude-rules', err]); }
    else ok(`  [1/3] Signal${leanBody != null ? ' + Lean' : ''} rule written to ${claudeMd}`);
  }

  // 1b. EAP-Lean skills (mode + review/audit/debt/gain/help) → <configDir>/skills/
  // so /eap-lean* is discoverable. Prompt-only markdown; gated by opts.lean.
  if (opts.lean && !opts.dryRun) {
    const sErr = installSkills(configDir, opts, LEAN_SKILLS_SRC, LEAN_SKILLS);
    if (sErr) warn(`  [1/3] EAP-Lean skills install failed: ${sErr}`);
    else ok(`  [1/3] EAP-Lean skills (${LEAN_SKILLS.length}) installed to ${path.join(configDir, 'skills')}`);
  } else if (opts.lean) {
    note(`  [1/3] EAP-Lean skills: copy ${LEAN_SKILLS.length} into ${path.join(configDir, 'skills')}`);
  }

  // 1c. EAP-Runtime skills (stats/search/doctor/purge) — chat wrappers over the
  // eap_* MCP tools; gated by opts.runtime.
  if (opts.runtime && !opts.dryRun) {
    const rErr = installSkills(configDir, opts, RUNTIME_SKILLS_SRC, RUNTIME_SKILLS);
    if (rErr) warn(`  [1/3] EAP-Runtime skills install failed: ${rErr}`);
    else ok(`  [1/3] EAP-Runtime skills (${RUNTIME_SKILLS.length}) installed to ${path.join(configDir, 'skills')}`);
  } else if (opts.runtime) {
    note(`  [1/3] EAP-Runtime skills: copy ${RUNTIME_SKILLS.length} into ${path.join(configDir, 'skills')}`);
  }

  // 1d. EAP-Signal skills + eapcrew agents + slash commands (always with Signal).
  {
    const sigErr = installSkills(configDir, opts, SIGNAL_SKILLS_SRC, SIGNAL_SKILLS);
    if (sigErr) warn(`  [1/3] EAP-Signal skills install failed: ${sigErr}`);
    else ok(`  [1/3] EAP-Signal skills (${SIGNAL_SKILLS.length}) installed to ${path.join(configDir, 'skills')}`);
    const aErr = installAgents(configDir, opts);
    if (aErr) warn(`  [1/3] eapcrew agents install failed: ${aErr}`);
    else ok(`  [1/3] eapcrew agents (${SIGNAL_AGENTS.length}) → ${path.join(configDir, 'agents')}`);
    const cErr = installCommands(configDir, opts);
    if (cErr) warn(`  [1/3] Signal commands install failed: ${cErr}`);
    else ok(`  [1/3] Signal commands → ${path.join(configDir, 'commands')}`);
  }

  // 2. MCP servers.
  if (serverNames.length === 0) {
    note('  [2/3] MCP: both servers disabled (--no-runtime --no-context) — skipped');
  } else if (useCli) {
    let allOk = true;
    for (const [name, s] of Object.entries(servers)) {
      // --scope user: register globally so the server is available in EVERY
      // project, not just the install-time directory (claude mcp add defaults to
      // the per-directory "local" scope). Capture output so an idempotent
      // "already exists" is treated as success, not a failure.
      const r = child_process.spawnSync('claude', ['mcp', 'add', '--scope', 'user', name, '--', s.command, ...s.args], { encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      if ((r.status || 0) === 0) continue;
      if (/already exists/i.test(out)) { note(`  claude MCP ${name} already registered`); continue; }
      allOk = false;
      warn(`  claude mcp add ${name} failed: ${(out.trim().split('\n')[0] || '').slice(0, 120)}`);
    }
    if (allOk) ok(`  [2/3] MCP registered via 'claude mcp add --scope user': ${serverNames.join(', ')}`);
  } else {
    const cfg = readSettings(mcpPath);
    if (cfg === null) { warn(`  ${mcpPath} unparseable — skipping MCP registration`); results.failed.push(['claude-mcp', 'mcp file unparseable']); }
    else if (!isPlainObject(cfg)) {
      // Valid JSON but a non-object root (array / bare string / number) can't hold
      // an mcpServers map: mutating it would crash (string) or silently vanish on
      // JSON.stringify (array). Leave it byte-for-byte untouched.
      warn(`  ${mcpPath} is not a JSON object; leaving it untouched.`); results.failed.push(['claude-mcp', 'mcp file is not a JSON object']);
    } else {
      const err = tryWrite(() => {
        if (!isPlainObject(cfg.mcpServers)) cfg.mcpServers = {};
        for (const [name, s] of Object.entries(servers)) cfg.mcpServers[name] = s;
        backupOnce(mcpPath);
        writeSettings(mcpPath, cfg);
      });
      if (err) { warn(`  [2/3] MCP write failed (${mcpPath}): ${err}`); results.failed.push(['claude-mcp', err]); }
      else ok(`  [2/3] MCP registered in ${mcpPath}: ${serverNames.join(', ')}`);
    }
  }

  // 3. Hooks → settings.json.
  const settings = readSettings(settingsPath);
  if (settings === null) { warn(`  ${settingsPath} unparseable — skipping hook wiring`); results.failed.push(['claude-hooks', 'settings.json unparseable']); }
  else if (!isPlainObject(settings)) {
    // A valid-JSON but non-object root (array / bare string / number) can't carry
    // a hooks map. Leave it untouched rather than crash or falsely report success.
    warn(`  ${settingsPath} is not a JSON object; leaving it untouched.`); results.failed.push(['claude-hooks', 'settings.json is not a JSON object']);
  } else {
    const err = tryWrite(() => {
      backupOnce(settingsPath);
      for (const { event, matcher, timeout } of HOOK_EVENTS) {
        addCommandHook(settings, event, {
          command: `"${node}" "${HOOK_DISPATCH}" ${event} "${eapConfPath}"`,
          commandWindows: psCommandWindows(node, HOOK_DISPATCH, event, eapConfPath),
          marker: HOOK_MARKER, matcher: matcher || undefined, timeout,
        });
      }
      // Statusline: only claim the slot if the user hasn't set one — never clobber.
      if (!isPlainObject(settings.statusLine)) {
        settings.statusLine = {
          type: 'command',
          command: `"${node}" "${STATUSLINE}"`,
          // Prefer the .ps1 wrapper on Windows (resolves node like install.ps1).
          commandWindows: fs.existsSync(STATUSLINE_PS1)
            ? `powershell -NoProfile -File "${STATUSLINE_PS1.replace(/"/g, '\\"')}"`
            : psCommandWindows(node, STATUSLINE),
        };
      }
      validateHookFields(settings, warn);
      writeSettings(settingsPath, settings);
    });
    if (err) { warn(`  [3/3] Hooks write failed (${settingsPath}): ${err}`); results.failed.push(['claude-hooks', err]); }
    else ok(`  [3/3] Hooks wired in ${settingsPath}: ${HOOK_EVENTS.map((h) => h.event).join(', ')}`);
  }

  // Layer flags for the dispatcher (runtime/context enable state + repo root).
  const flagsErr = tryWrite(() => writeSettings(eapConfPath, { root: REPO_ROOT, runtime: opts.runtime, context: opts.context, lean: opts.lean, signalStatic: true, version: 1 }));
  if (flagsErr) { warn(`  layer-flags write failed (${eapConfPath}): ${flagsErr}`); results.failed.push(['claude-flags', flagsErr]); }

  // Optional MCP shrink proxy wrapping an upstream server.
  installMcpShrink(ctx);

  results.installed.push('claude');
}

function backupOnce(p) {
  const bak = p + '.eap.bak';
  if (fs.existsSync(p) && !fs.existsSync(bak)) {
    try { fs.copyFileSync(p, bak, fs.constants.COPYFILE_EXCL); } catch { /* pre-existing / symlink */ }
  }
}

// On uninstall, drop a now-empty JSON stub the installer itself created. The
// installer writes {} into a .mcp.json / settings.json that did not exist
// before (and backupOnce leaves NO *.eap.bak in that case). If uninstall emptied
// it back to {} and there is no backup, the file is ours and purely a leftover
// stub — remove it. A pre-existing (backed-up) file is always preserved, as are
// the intentional *.eap.bak backups. Returns true if the file was removed.
function removeInstallerCreatedEmpty(file, obj) {
  if (!isPlainObject(obj) || Object.keys(obj).length !== 0) return false;
  if (fs.existsSync(file + '.eap.bak')) return false; // pre-existed → keep
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// Skill names installed onto every native host that declares native.skills.
function nativeSkillNames(opts) {
  const names = [...SIGNAL_SKILLS];
  if (opts.lean) names.push(...LEAN_SKILLS);
  // Runtime skills (incl. eap-update) when MCP runtime layer is enabled — same
  // gate as Claude. MCP-less hosts (pi/windsurf) still get the CLI eap-update
  // skill; the other runtime skills are harmless prompt wrappers.
  if (opts.runtime) names.push(...RUNTIME_SKILLS);
  return names;
}

// Copy Signal (+ Lean [+ Runtime]) skills, and optional commands/agents, into a
// native provider's declared directories. Dry-run notes only.
function installNativeAssets(ctx, prov) {
  const { opts, note, ok, warn } = ctx;
  const n = prov.native || {};
  if (n.skills) {
    const root = resolveSentinelPath(n.skills);
    const names = nativeSkillNames(opts);
    if (opts.dryRun) {
      note(`  skills: copy ${names.length} into ${root}/`);
    } else {
      const err = installSkillsInto(root, opts, SIGNAL_SKILLS_SRC, SIGNAL_SKILLS);
      if (err) warn(`  Signal skills failed (${root}): ${err}`);
      else {
        let failed = false;
        if (opts.lean) {
          const lerr = installSkillsInto(root, opts, LEAN_SKILLS_SRC, LEAN_SKILLS);
          if (lerr) { warn(`  Lean skills failed (${root}): ${lerr}`); failed = true; }
        }
        if (opts.runtime) {
          const rerr = installSkillsInto(root, opts, RUNTIME_SKILLS_SRC, RUNTIME_SKILLS);
          if (rerr) { warn(`  Runtime skills failed (${root}): ${rerr}`); failed = true; }
        }
        if (!failed) ok(`  skills (${names.length}) → ${root}`);
      }
    }
  }
  if (n.commands) {
    const dest = resolveSentinelPath(n.commands);
    if (opts.dryRun) note(`  commands: copy Signal slash cmds into ${dest}/`);
    else {
      const err = installCommandsInto(dest, opts);
      if (err) warn(`  commands failed (${dest}): ${err}`);
      else ok(`  commands → ${dest}`);
    }
  }
  if (n.agents) {
    const dest = resolveSentinelPath(n.agents);
    if (opts.dryRun) note(`  agents: copy eapcrew into ${dest}/`);
    else {
      // opencode rejects Claude's YAML-array `tools:`; strip it (a single bad
      // file invalidates the whole opencode config). `model:` is left intact.
      const err = installAgentsInto(dest, opts, stripOpencodeAgentTools);
      if (err) warn(`  agents failed (${dest}): ${err}`);
      else ok(`  agents → ${dest}`);
    }
  }
}

// Gemini CLI extension: stage gemini-extension.json + generated GEMINI.md
// (Signal+Lean from sources — no drifted copy in-repo) then
// `gemini extensions install <staging>`.
const GEMINI_EXT_JSON = path.join(REPO_ROOT, 'layers', 'eap-signal', 'gemini-extension.json');

function buildGeminiContextMd(warn, lean) {
  const signal = buildSignalBody(warn);
  if (signal == null) return null;
  const parts = [
    '# EAP — Gemini extension context\n',
    `${SIGNAL_BEGIN}\n${signal}\n${SIGNAL_END}\n`,
  ];
  if (lean) {
    const leanBody = buildLeanBody(warn);
    if (leanBody != null) parts.push(`${LEAN_BEGIN}\n${leanBody}\n${LEAN_END}\n`);
  }
  return parts.join('\n');
}

function installGeminiExt(ctx, prov) {
  const { opts, say, note, ok, warn, results } = ctx;
  say(`→ ${prov.label} — installing EAP Gemini extension (Signal${opts.lean ? ' + Lean' : ''})`);
  if (!fs.existsSync(GEMINI_EXT_JSON)) {
    warn('  gemini-extension.json missing — cannot wire Gemini');
    results.failed.push([prov.id, 'gemini-extension.json missing']);
    return;
  }
  const ctxMd = buildGeminiContextMd(warn, opts.lean);
  if (ctxMd == null) { results.failed.push([prov.id, 'Signal rule unreadable']); return; }

  // File-based extension drop under ~/.gemini/extensions/eap (works offline).
  // When `gemini` is on PATH, also run `gemini extensions install` for registry.
  const extDir = path.join(os.homedir(), '.gemini', 'extensions', 'eap');

  if (opts.dryRun) {
    note(`  Gemini: write ${extDir}/gemini-extension.json + GEMINI.md`);
    if (hasCmd('gemini')) note(`  Gemini: gemini extensions install ${extDir}`);
    results.dryRun.push(prov.id);
    return;
  }

  try {
    fs.mkdirSync(extDir, { recursive: true });
    fs.copyFileSync(GEMINI_EXT_JSON, path.join(extDir, 'gemini-extension.json'));
    atomicWrite(path.join(extDir, 'GEMINI.md'), ctxMd, 0o644);
    ok(`  Gemini extension files → ${extDir}`);
    if (hasCmd('gemini')) {
      let r = child_process.spawnSync('gemini', ['extensions', 'install', extDir, '--force'], {
        encoding: 'utf8', stdio: 'pipe',
      });
      if ((r.status || 0) !== 0) {
        r = child_process.spawnSync('gemini', ['extensions', 'install', extDir], {
          encoding: 'utf8', stdio: 'pipe',
        });
      }
      if ((r.status || 0) === 0) ok('  Gemini: registered via gemini extensions install');
      else {
        const msg = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0] || 'unknown';
        warn(`  gemini extensions install failed (${msg}); files remain at ${extDir}`);
      }
    } else {
      note('  gemini CLI not on PATH — files written; run `gemini extensions install` later if needed');
    }
    results.installed.push(prov.id);
  } catch (e) {
    warn(`  Gemini install failed: ${(e && e.message) || e}`);
    results.failed.push([prov.id, (e && e.message) || 'gemini install failed']);
  }
}

// ── Native EAP-Signal install (non-Claude AGENTS.md / SOUL.md / IDE rules) ───
// Writes the SAME managed blocks installClaude writes into native.signal, then
// drops skills/commands/agents when declared. MCP is a separate follow-up step.
function installSignalNative(ctx, prov) {
  const { opts, say, note, ok, warn, results } = ctx;
  const n = prov.native || {};

  if (n.kind === 'gemini-ext') { installGeminiExt(ctx, prov); return; }

  const target = resolveNativeSignal(prov);
  if (target == null) {
    // Skills/MCP-only native (no rules file) — still install assets.
    say(`→ ${prov.label} — no global rules file; installing declared assets`);
    if (opts.dryRun) {
      installNativeAssets(ctx, prov);
      results.dryRun.push(prov.id);
    } else {
      installNativeAssets(ctx, prov);
      results.installed.push(prov.id);
    }
    return;
  }

  const signalBody = buildSignalBody(warn);
  const leanBody = opts.lean ? buildLeanBody(warn) : null;
  say(`→ ${prov.label} — installing EAP-Signal${leanBody != null ? ' + EAP-Lean' : ''} (native)`);
  if (signalBody == null) { results.failed.push([prov.id, 'Signal rule unreadable']); return; }

  if (opts.dryRun) {
    note(`  Signal: write managed ${SIGNAL_BEGIN} block into ${target}`);
    if (leanBody != null) note(`  Lean: write managed ${LEAN_BEGIN} block into ${target}`);
    installNativeAssets(ctx, prov);
    results.dryRun.push(prov.id);
    return;
  }

  const err = writeRulesBlocks(target, signalBody, leanBody, n.frontmatter);
  if (err) { warn(`  rules write failed for ${prov.label} (${target}): ${err}`); results.failed.push([prov.id, err]); return; }
  ok(`  Signal${leanBody != null ? ' + Lean' : ''} rule written to ${target}`);
  installNativeAssets(ctx, prov);
  results.installed.push(prov.id);
}

// ── Native MCP install (register eap-runtime + eap-context) ──────────────────
// Registers the two EAP MCP servers into an MCP-capable native agent, using the
// per-agent mechanism declared in prov.native.mcp. Called right after
// installSignalNative so a native agent gets Signal THEN MCP. Providers without a
// native.mcp descriptor (pi) are a no-op. Honors --no-runtime / --no-context
// (register only the enabled servers) and --dry-run (print, write nothing).

// Minimal display quoting for a printed manual/dry-run command line: quote an
// arg only when it holds a shell-active char, so the printout is copy-pasteable.
function shDisplayQuote(s) {
  s = String(s);
  return /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

// Build the argv the agent CLI expects for one server (everything after the bin).
function cliMcpArgv(kind, name, s) {
  if (kind === 'cli-hermes') return ['mcp', 'add', name, '--command', s.command, '--args', ...s.args];
  return ['mcp', 'add', name, '--', s.command, ...s.args]; // cli-dashdash
}

// Build the JSON value merged under the agent's MCP key for one server.
function mcpJsonEntry(shape, s) {
  if (shape === 'command-array-local') return { type: 'local', command: [s.command, ...s.args], enabled: true };
  return { command: s.command, args: s.args }; // command-args
}

function installMcpNative(ctx, prov) {
  const { opts, note } = ctx;
  const desc = prov.native && prov.native.mcp;
  if (!desc) return; // MCP not supported for this native agent (e.g. pi)
  const servers = mcpServers(opts); // no projectRoot -> eap-context defaults root to "."
  if (Object.keys(servers).length === 0) { note('  MCP: both servers disabled (--no-runtime --no-context) — skipped'); return; }
  if (desc.kind === 'cli-dashdash' || desc.kind === 'cli-hermes') installMcpCli(ctx, prov, desc, servers);
  else if (desc.kind === 'json') installMcpJson(ctx, prov, desc, servers);
}

function installMcpCli(ctx, prov, desc, servers) {
  const { opts, note, ok, warn, results } = ctx;
  const bin = desc.bin;
  const present = hasCmd(bin);
  for (const [name, s] of Object.entries(servers)) {
    const argv = cliMcpArgv(desc.kind, name, s);
    const printable = `${bin} ${argv.map(shDisplayQuote).join(' ')}`;
    if (opts.dryRun) { note(`  MCP: ${printable}`); continue; }
    if (!present) {
      warn(`  ${bin} not found on PATH — cannot auto-register ${name}.`);
      note(`  To register manually once ${bin} is installed, run: ${printable}`);
      continue;
    }
    // `hermes mcp add` has two possible confirmations: overwrite when a server
    // already exists, then enable all discovered tools. Supplying both answers
    // keeps first installs and idempotent re-installs fully non-interactive.
    const spawnOpts = desc.kind === 'cli-hermes'
      ? { input: 'y\ny\n', stdio: ['pipe', 'inherit', 'inherit'] }
      : { stdio: 'inherit' };
    const r = child_process.spawnSync(bin, argv, spawnOpts);
    if ((r.status || 0) !== 0) { warn(`  ${bin} mcp add ${name} failed`); results.failed.push([`${prov.id}-mcp`, `${name} registration failed`]); }
    else ok(`  MCP registered via '${bin} mcp add': ${name}`);
  }
}

function installMcpJson(ctx, prov, desc, servers) {
  const { opts, note, ok, warn, results } = ctx;
  const file = resolveSentinelPath(desc.file);
  const key = desc.key;
  const names = Object.keys(servers);

  if (opts.dryRun) {
    note(`  MCP: merge ${names.join(' + ')} into ${file} (key "${key}")`);
    for (const [name, s] of Object.entries(servers)) note(`         ${name}: ${JSON.stringify(mcpJsonEntry(desc.shape, s))}`);
    return;
  }

  // readSettings is JSONC-tolerant, so an opencode.jsonc carrying // comments, a
  // $schema, and a plugin array parses cleanly. We MERGE our two keys and write
  // the result back with writeSettings, which re-emits via JSON.stringify: every
  // DATA key (existing servers, $schema, plugin array, all siblings) is
  // preserved, but the rewrite NORMALIZES the file — user comments are NOT
  // retained (a comment-preserving JSONC writer is out of scope). A null return
  // means the file is unrecoverable; a non-object root is left untouched.
  const cfg = readSettings(file);
  if (cfg === null) { warn(`  ${file} unparseable — skipping MCP registration`); results.failed.push([`${prov.id}-mcp`, 'mcp file unparseable']); return; }
  if (!isPlainObject(cfg)) {
    // Valid JSON but a non-object root (array / bare string / number): merging
    // would crash (string) or silently vanish on JSON.stringify (array). Skip.
    warn(`  ${file} is not a JSON object; leaving it untouched.`); results.failed.push([`${prov.id}-mcp`, 'mcp file is not a JSON object']); return;
  }
  // Note when we are about to normalize a commented/JSONC file, so the "comments
  // are dropped on rewrite" behavior is surfaced rather than silent. Cheap+safe
  // signal: strict JSON.parse fails (after BOM strip) only when comments/trailing
  // commas are present, i.e. the JSONC recovery path in readSettings was used.
  let normalizingJsonc = false;
  if (fs.existsSync(file)) {
    try {
      let raw = fs.readFileSync(file, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      JSON.parse(raw);
    } catch { normalizingJsonc = true; }
  }
  const err = tryWrite(() => {
    if (!isPlainObject(cfg[key])) cfg[key] = {};
    for (const [name, s] of Object.entries(servers)) cfg[key][name] = mcpJsonEntry(desc.shape, s);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupOnce(file);
    writeSettings(file, cfg);
  });
  if (err) { warn(`  MCP write failed (${file}): ${err}`); results.failed.push([`${prov.id}-mcp`, err]); return; }
  ok(`  MCP registered in ${file}: ${names.join(', ')}`);
  if (normalizingJsonc) note('  note: JSONC file rewritten — all data/keys preserved, comments/formatting normalized away.');
}

// Remove the two EAP MCP registrations from a native agent (uninstall). CLI
// agents get `<bin> mcp remove <name>` (idempotent; skipped when the bin is
// absent); JSON agents get the two keys deleted, leaving all other servers
// intact. Honors --dry-run.
function uninstallMcpNative(ctx, prov) {
  const { opts, note, ok } = ctx;
  const desc = prov.native && prov.native.mcp;
  if (!desc) return;
  const names = ['eap-runtime', 'eap-context'];
  if (desc.kind === 'cli-dashdash' || desc.kind === 'cli-hermes') {
    const bin = desc.bin;
    if (opts.dryRun) { for (const n of names) note(`  ${bin} mcp remove ${n}`); return; }
    if (!hasCmd(bin)) return; // no CLI on PATH — nothing to do
    for (const n of names) child_process.spawnSync(bin, ['mcp', 'remove', n], { stdio: 'ignore' });
    ok(`  removed EAP MCP servers from ${prov.label} via '${bin} mcp remove'`);
  } else if (desc.kind === 'json') {
    const file = resolveSentinelPath(desc.file);
    if (!fs.existsSync(file)) return;
    const cfg = readSettings(file);
    if (!cfg || !cfg[desc.key] || typeof cfg[desc.key] !== 'object') return;
    let removed = 0;
    for (const n of names) if (cfg[desc.key][n]) { delete cfg[desc.key][n]; removed++; }
    if (removed === 0) return;
    if (Object.keys(cfg[desc.key]).length === 0) delete cfg[desc.key];
    // If the installer created this file and nothing else remains, delete the
    // empty {} stub rather than leaving it behind (parity with the claude path).
    if (!opts.dryRun && !removeInstallerCreatedEmpty(file, cfg)) writeSettings(file, cfg);
    ok(`  removed ${removed} EAP MCP entr${removed === 1 ? 'y' : 'ies'} from ${prov.label} (${file})`);
  }
}

// ── Planned providers (detected, honestly not wired) ────────────────────────
function planProvider(ctx, prov) {
  const { note } = ctx;
  note(`→ ${prov.label} detected — EAP wiring PLANNED (not yet end-to-end).`);
  note('  Today EAP is wired end-to-end for Claude Code only. For this agent you can:');
  note(`    • Signal: paste ${SIGNAL_RULE} into its always-on rules/memory file.`);
  note(`    • Lean:   paste ${LEAN_RULE} into the same file (minimal-code craft).`);
  note(`    • MCP:   add eap-runtime (node ${RUNTIME_MCP}) and eap-context`);
  note(`             (python3 ${CONTEXT_MCP} <project-root>) to its MCP config.`);
  ctx.results.planned.push(prov.id);
}

// ── uninstall (Claude Code) ─────────────────────────────────────────────────
function uninstall(ctx) {
  const { opts, configDir, say, note, ok, warn } = ctx;
  say('EAP uninstall');
  if (opts.dryRun) note('  (dry run — nothing will be removed)');

  const claudeMd = path.join(configDir, 'CLAUDE.md');
  const settingsPath = path.join(configDir, 'settings.json');
  const mcpPath = path.join(configDir, '.mcp.json');
  const eapConfPath = path.join(configDir, '.eap.json');
  const useCli = !ctx.configDirExplicit && hasCmd('claude');

  // 1. Signal + Lean always-on blocks.
  if (fs.existsSync(claudeMd)) {
    const { text, stripped } = stripEapBlocks(fs.readFileSync(claudeMd, 'utf8'));
    if (stripped && !opts.dryRun) {
      if (text === '') { try { fs.unlinkSync(claudeMd); } catch { /* best effort */ } }
      else atomicWrite(claudeMd, text, 0o644);  // symlink-safe, matches install
    }
    if (stripped) ok(text === '' ? `  removed ${claudeMd}` : `  stripped EAP blocks from ${claudeMd}`);
  }

  // 1b. EAP-Lean + EAP-Runtime + EAP-Signal skills; eapcrew agents; commands.
  const skillsRemoved = uninstallSkills(configDir, opts, [...LEAN_SKILLS, ...RUNTIME_SKILLS, ...SIGNAL_SKILLS]);
  if (skillsRemoved) ok(`  removed ${skillsRemoved} EAP skill(s) from ${path.join(configDir, 'skills')}`);
  if (!opts.dryRun) {
    for (const name of SIGNAL_AGENTS) {
      const p = path.join(configDir, 'agents', name);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* */ }
    }
    if (fs.existsSync(SIGNAL_COMMANDS_SRC)) {
      for (const ent of fs.readdirSync(SIGNAL_COMMANDS_SRC)) {
        const p = path.join(configDir, 'commands', ent);
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* */ }
      }
    }
  }

  // 2. MCP servers. Remove at --scope user to match the install scope.
  if (useCli) {
    for (const name of ['eap-runtime', 'eap-context', 'eap-signal-shrink']) {
      if (!opts.dryRun) child_process.spawnSync('claude', ['mcp', 'remove', '--scope', 'user', name], { stdio: 'ignore' });
    }
    ok('  removed MCP servers via `claude mcp remove`');
  } else if (fs.existsSync(mcpPath)) {
    const cfg = readSettings(mcpPath);
    if (isPlainObject(cfg) && cfg.mcpServers) {
      let removed = 0;
      for (const name of ['eap-runtime', 'eap-context', 'eap-signal-shrink']) if (cfg.mcpServers[name]) { delete cfg.mcpServers[name]; removed++; }
      if (isPlainObject(cfg.mcpServers) && Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
      if (!opts.dryRun) {
        // Drop a now-empty stub we created; otherwise write the trimmed config.
        if (!removeInstallerCreatedEmpty(mcpPath, cfg)) writeSettings(mcpPath, cfg);
      }
      ok(`  removed ${removed} MCP server entr${removed === 1 ? 'y' : 'ies'} from ${mcpPath}`);
    }
  }

  // 3. Hooks.
  if (fs.existsSync(settingsPath)) {
    const settings = readSettings(settingsPath);
    if (settings) {
      const removed = removeCommandHooks(settings, HOOK_MARKER);
      // Statusline: remove only if it is ours (points at eap-statusline).
      if (isPlainObject(settings.statusLine) && typeof settings.statusLine.command === 'string'
        && settings.statusLine.command.includes('eap-statusline')) {
        delete settings.statusLine;
      }
      validateHookFields(settings, warn);
      if (!opts.dryRun) {
        // Drop a now-empty stub we created; otherwise write the trimmed settings.
        if (!removeInstallerCreatedEmpty(settingsPath, settings)) writeSettings(settingsPath, settings);
      }
      ok(`  removed ${removed} EAP hook entr${removed === 1 ? 'y' : 'ies'} from ${settingsPath}`);
    }
  }

  // Layer-flags file.
  if (fs.existsSync(eapConfPath) && !opts.dryRun) { try { fs.unlinkSync(eapConfPath); } catch { /* best effort */ } }

  // Native EAP-Signal + EAP-Lean blocks (codex/opencode/pi/grok/antigravity/
  // hermes/cursor/windsurf/cline). Strip managed fences; delete the file when
  // nothing but optional IDE frontmatter remains.
  for (const prov of PROVIDERS) {
    if (!prov.native || prov.native.kind === 'gemini-ext') continue;
    const target = resolveNativeSignal(prov);
    if (target == null || !fs.existsSync(target)) continue;
    const { text, stripped } = stripEapBlocks(fs.readFileSync(target, 'utf8'));
    if (!stripped) continue;
    const fm = prov.native.frontmatter || '';
    const leftover = text.replace(fm, '').trim();
    if (!opts.dryRun) {
      if (leftover === '') { try { fs.unlinkSync(target); } catch { /* best effort */ } }
      else atomicWrite(target, text, 0o644); // symlink-safe, matches install
    }
    ok(leftover === '' ? `  removed ${target}` : `  stripped EAP blocks from ${prov.label} (${target})`);
  }

  // Native skills / commands / agents trees.
  const skillNames = [...SIGNAL_SKILLS, ...LEAN_SKILLS, ...RUNTIME_SKILLS];
  for (const prov of PROVIDERS) {
    if (!prov.native) continue;
    if (prov.native.skills) {
      const root = resolveSentinelPath(prov.native.skills);
      let removed = 0;
      for (const name of skillNames) {
        const dir = path.join(root, name);
        if (!fs.existsSync(dir)) continue;
        if (!opts.dryRun) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
        removed++;
      }
      if (removed) ok(`  removed ${removed} EAP skill(s) from ${prov.label} (${root})`);
    }
    if (prov.native.commands && !opts.dryRun && fs.existsSync(SIGNAL_COMMANDS_SRC)) {
      const dest = resolveSentinelPath(prov.native.commands);
      for (const ent of fs.readdirSync(SIGNAL_COMMANDS_SRC)) {
        try { fs.unlinkSync(path.join(dest, ent)); } catch { /* */ }
      }
    }
    if (prov.native.agents && !opts.dryRun) {
      const dest = resolveSentinelPath(prov.native.agents);
      for (const name of SIGNAL_AGENTS) {
        try { fs.unlinkSync(path.join(dest, name)); } catch { /* */ }
      }
    }
  }

  // Gemini extension files + optional CLI unregister.
  const geminiExt = path.join(os.homedir(), '.gemini', 'extensions', 'eap');
  if (fs.existsSync(geminiExt)) {
    if (!opts.dryRun) { try { fs.rmSync(geminiExt, { recursive: true, force: true }); } catch { /* */ } }
    ok(`  removed Gemini extension dir ${geminiExt}`);
  }
  if (hasCmd('gemini') && !opts.dryRun) {
    child_process.spawnSync('gemini', ['extensions', 'uninstall', 'eap'], { stdio: 'ignore' });
  }

  // Native MCP registrations (codex/grok/hermes CLI + cursor/antigravity/opencode
  // JSON). Remove only the two EAP servers; every other registered server and
  // sibling config key is preserved.
  for (const prov of PROVIDERS) {
    if (prov.native && prov.native.mcp) uninstallMcpNative(ctx, prov);
  }

  process.stdout.write('\n');
  ok('uninstall done.');
}

// ── --list ──────────────────────────────────────────────────────────────────
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function printList(noColor) {
  const c = makeChalk(noColor);
  const wired = PROVIDERS.filter((p) => p.wired).length;
  const signalMcp = PROVIDERS.filter((p) => !p.wired && p.native && p.native.mcp).length;
  const signalOnly = PROVIDERS.filter((p) => !p.wired && p.native && !p.native.mcp).length;
  const planned = PROVIDERS.length - wired - signalMcp - signalOnly;
  process.stdout.write(c.cyan('EAP provider matrix') + '\n\n');
  process.stdout.write(`  ${pad('ID', 13)} ${pad('AGENT', 22)} STATUS\n`);
  process.stdout.write(`  ${pad('--', 13)} ${pad('-----', 22)} ------\n`);
  for (const p of PROVIDERS) {
    let status;
    if (p.wired) status = c.green('end-to-end (all 3 + lean)');
    else if (p.native && p.native.kind === 'gemini-ext') status = c.green('signal + lean (gemini ext)');
    else if (p.native && p.native.mcp) status = c.green('signal + lean + mcp');
    else if (p.native) status = c.green('signal + lean');
    else status = c.dim('planned');
    const soft = p.soft ? c.dim(' (soft-detect)') : '';
    process.stdout.write(`  ${pad(p.id, 13)} ${pad(p.label, 22)} ${status}${soft}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(c.dim(`  ${wired} provider wired end-to-end (Claude Code, all 3 layers + Lean); ${signalMcp} with native EAP-Signal + EAP-Lean + both MCP servers; ${signalOnly} EAP-Signal + EAP-Lean only (no MCP); ${planned} detected + planned.\n`));
  process.stdout.write(c.dim('  "signal + lean" = always-on rules (+ skills where the host has a skills dir); "+ mcp" adds both EAP MCP servers.\n'));
  process.stdout.write(c.dim('  EAP-Lean installs beside EAP-Signal everywhere Signal lands; pass --no-lean to opt out.\n'));
  process.stdout.write(c.dim('  Planned: marketplace-only hosts (continue/kilo/roo/…) and Copilot (no stable global instructions path).\n'));
  process.stdout.write(c.dim('  Layers: Signal + Lean (always-on rules) + eap-runtime MCP + eap-context MCP + hook dispatcher.\n'));
}

// ── help ────────────────────────────────────────────────────────────────────
function printHelp() {
  process.stdout.write(`eap-install — wire the three EAP layers into your AI coding agent.

USAGE
  node bin/eap-install.mjs [flags]
  node bin/eap-install.mjs update [update-flags]   # → bin/lib/update.mjs
  eap install | eap update | eap uninstall | eap list | eap doctor

Run with no flags on a terminal to launch the interactive TUI (auto-detect
agents, curate which agents + layers, confirm). Piped/CI runs use flags.

FLAGS
  --tui                  Force the interactive installer (default on a TTY).
  -y, --yes              In the TUI, skip the final confirm (accept the plan).
  --list                 Print the provider matrix (end-to-end vs planned) and exit.
  --dry-run              Print the full install plan; write nothing.
  --only <agent>         Install only for the named agent (see --list). Repeatable.
  --config-dir <path>    Claude Code config dir (CLAUDE.md + settings.json + .mcp.json).
                         Default: \$CLAUDE_CONFIG_DIR or ~/.claude.
  --no-runtime           Skip the eap-runtime (working-memory offload) MCP server.
  --no-context           Skip the eap-context (code-symbol-graph) MCP server.
  --no-lean              Skip the always-on EAP-Lean (minimal-code craft) rule.
  --with-mcp-shrink="<upstream>"
                         Register eap-signal-shrink wrapping <upstream> MCP cmd.
                         Example: --with-mcp-shrink="npx @modelcontextprotocol/server-filesystem /tmp"
  --no-mcp-shrink        Skip MCP shrink (default).
  --uninstall, -u        Remove the EAP Signal + Lean blocks, MCP entries, and hooks.
  --non-interactive      Never prompt; use defaults (skips the TUI).
  --no-color             Disable ANSI colors.
  --force                Reserved (installs are idempotent; re-runs are safe).
  -h, --help             Show this help.

WHAT GETS INSTALLED (Claude Code, end-to-end)
  1. EAP-Signal   -> managed block in <configDir>/CLAUDE.md
     EAP-Lean     -> second always-on managed block in the same CLAUDE.md (--no-lean opts out)
     skills       -> Signal + Lean + Runtime skills under <configDir>/skills/
     agents       -> eapcrew-* under <configDir>/agents/
     commands     -> slash commands under <configDir>/commands/
  2. eap-runtime -> node   ${RUNTIME_MCP}
     eap-context -> python3 ${CONTEXT_MCP} <project-root>
     eap-signal-shrink (optional) -> node ${SIGNAL_SHRINK} <upstream…>
  3. hooks       -> SessionStart / UserPromptSubmit / SubagentStart / PreToolUse /
                    PostToolUse / PreCompact / Stop in <configDir>/settings.json,
                    running src/hooks/eap-dispatch.mjs

NATIVE AGENTS (Signal + Lean rules; skills where supported; MCP where supported)
  codex, grok, hermes, antigravity, cursor
                     -> rules + Signal/Lean/Runtime skills + MCP (CLI or JSON)
  opencode           -> AGENTS.md + skills + commands (/eap-update) + eapcrew + MCP
  pi                 -> AGENTS.md + skills (no MCP)
  windsurf           -> ~/.windsurf/rules/eap.md + skills
  cline              -> ~/Documents/Cline/Rules/eap.md (rules only; skills need marketplace IDs)
  gemini             -> ~/.gemini/extensions/eap context (GEMINI.md); skills N/A
Planned (marketplace / no stable global adapter): Copilot, continue/kilo/roo/augment, and
the npx-skills marketplace CLI hosts — see --list.
`);
}

// ── main ────────────────────────────────────────────────────────────────────
// ── interactive TUI ─────────────────────────────────────────────────────────
// Zero-dep readline menu: auto-detect agents, let the user curate which agents
// and which layers to install, confirm, then hand control back to the normal
// install flow by populating `opts`. Runs on a real TTY only.
async function runTui(opts, c) {
  // Classic readline with an explicit line queue: buffered lines from a piped
  // stdin (curl | bash forwards the TUI's answers) are never dropped, unlike
  // readline/promises' question() which can lose a buffered line between calls.
  const rl = readline.createInterface({ input: process.stdin });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => { const w = waiters.shift(); if (w) w(line); else queue.push(line); });
  rl.on('close', () => { closed = true; let w; while ((w = waiters.shift())) w(null); });
  const nextLine = () => queue.length
    ? Promise.resolve(queue.shift())
    : (closed ? Promise.resolve(null) : new Promise((res) => waiters.push(res)));
  const ask = async (q, def) => {
    process.stdout.write(q);
    const line = await nextLine();
    const a = (line == null ? '' : String(line)).trim();
    return a === '' ? def : a;
  };
  try {
    process.stdout.write('\n' + c.cyan('  EAP — Efficient Agent Protocol') + '\n');
    process.stdout.write(c.dim('  Compress agent tokens at all three membranes: input · working · output') + '\n\n');

    // 0. If the user pre-scoped with --only, that IS the roster — skip detection
    //    (deterministic; also what a `--only x --tui` invocation means).
    if (opts.only.length) {
      const chosen = PROVIDERS.filter((p) => opts.only.includes(p.id));
      process.stdout.write(c.green('  Targets (from --only):') + '\n');
      chosen.forEach((p) => process.stdout.write(`    • ${p.label} ${p.wired ? c.green('[end-to-end]') : c.dim('[planned]')}\n`));
      process.stdout.write('\n');
      const anyW = chosen.some((p) => p.wired);
      if (anyW) {
        opts.runtime = !/^n/i.test(await ask(c.cyan('  Enable EAP-Runtime MCP? ') + c.dim('[Y/n] '), 'y'));
        opts.context = !/^n/i.test(await ask(c.cyan('  Enable EAP-Context MCP? ') + c.dim('[Y/n] '), 'y'));
      }
      const layers0 = 'Signal' + (opts.lean ? ' + Lean' : '') + (opts.runtime ? ' + Runtime' : '') + (opts.context ? ' + Context' : '');
      process.stdout.write('\n' + c.cyan('  Plan: ') + `${chosen.map((p) => p.label).join(', ')}  ·  layers: ${layers0}\n`);
      if (!opts.yes) {
        if (/^n/i.test(await ask(c.cyan('  Proceed? ') + c.dim('[Y/n] '), 'y'))) { process.stdout.write(c.dim('  Cancelled.\n')); return false; }
      }
      return true;
    }

    // 1. Detect agents. Soft providers only surface when explicitly chosen, so
    //    the auto-detected list mirrors a no-flag run.
    const detected = PROVIDERS.filter((p) => !p.soft && detectMatch(p.detect));
    let roster = detected;
    if (detected.length === 0) {
      process.stdout.write(c.yellow('  No supported agents auto-detected on this machine.') + '\n');
      const pick = await ask(c.cyan('  Install anyway? Enter an agent id (see --list), or blank to cancel: '), '');
      if (!pick) { process.stdout.write(c.dim('  Cancelled.\n')); return false; }
      const p = PROVIDERS.find((x) => x.id === pick || x.id === (pick === 'aider' ? 'aider-desk' : pick));
      if (!p) { process.stdout.write(c.red(`  Unknown agent: ${pick}\n`)); return false; }
      roster = [p];
    } else {
      process.stdout.write(c.green(`  Detected ${detected.length} agent(s):`) + '\n');
      detected.forEach((p, i) => {
        const badge = p.wired ? c.green('[end-to-end]') : c.dim('[planned]');
        process.stdout.write(`    ${c.cyan(String(i + 1))}. ${p.label.padEnd(20)} ${badge}\n`);
      });
      process.stdout.write('\n');
      const sel = await ask(
        c.cyan('  Which to set up? ') + c.dim('[Enter = all detected · comma numbers e.g. 1,3 · q = quit] '), 'all');
      if (sel.toLowerCase() === 'q') { process.stdout.write(c.dim('  Cancelled.\n')); return false; }
      if (sel.toLowerCase() !== 'all') {
        const idx = sel.split(',').map((n) => parseInt(n.trim(), 10) - 1).filter((n) => n >= 0 && n < detected.length);
        if (idx.length) roster = idx.map((i) => detected[i]);
      }
    }

    // 2. Layer curation. Signal is always on; Runtime/Context are optional MCP
    //    servers. Only offer the MCP toggles when an end-to-end agent is chosen
    //    (planned agents get a manual plan regardless).
    const anyWired = roster.some((p) => p.wired);
    if (anyWired) {
      const rt = await ask(c.cyan('  Enable EAP-Runtime (working-memory offload MCP)? ') + c.dim('[Y/n] '), 'y');
      opts.runtime = !/^n/i.test(rt);
      const cx = await ask(c.cyan('  Enable EAP-Context (code-graph MCP)? ') + c.dim('[Y/n] '), 'y');
      opts.context = !/^n/i.test(cx);
    }

    // 3. Confirm.
    opts.only = roster.map((p) => p.id);
    const layers = 'Signal' + (opts.lean ? ' + Lean' : '') + (opts.runtime ? ' + Runtime' : '') + (opts.context ? ' + Context' : '');
    process.stdout.write('\n' + c.cyan('  Plan: ') + `${roster.map((p) => p.label).join(', ')}  ·  layers: ${layers}\n`);
    if (!opts.yes) {
      const go = await ask(c.cyan('  Proceed? ') + c.dim('[Y/n] '), 'y');
      if (/^n/i.test(go)) { process.stdout.write(c.dim('  Cancelled.\n')); return false; }
    }
    return true;
  } finally {
    rl.close();
  }
}

async function main() {
  const rawArgv = process.argv.slice(2);
  // `node bin/eap-install.mjs update …` delegates to the graceful updater so
  // the legacy bin keeps working as a single entrypoint too.
  if (rawArgv[0] === 'update') {
    const { runUpdateCli } = await import('./lib/update.mjs');
    return runUpdateCli(rawArgv.slice(1), {
      repoRoot: REPO_ROOT,
      installBin: __filename,
    });
  }
  const opts = parseArgs(rawArgv);
  if (opts.help) { printHelp(); return 0; }
  if (opts.listOnly) { printList(opts.noColor); return 0; }

  const cTui = makeChalk(opts.noColor);
  // Launch the interactive TUI when the user asked for it, or by default on a
  // real terminal with no explicit targets/action. Piped/CI invocations
  // (--non-interactive, no TTY) skip it and use flags.
  const wantTui = !opts.uninstall &&
    (opts.tui || (!opts.dryRun && !opts.nonInteractive && process.stdin.isTTY && process.stdout.isTTY && opts.only.length === 0));
  if (wantTui) {
    const proceed = await runTui(opts, cTui);
    if (!proceed) return 0;
    process.stdout.write('\n');
  }
  return runInstall(opts);
}

function runInstall(opts) {

  const c = makeChalk(opts.noColor);
  const configDir = opts.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const configDirExplicit = opts.configDir != null;

  // The resolved config-dir is interpolated into settings.json hook command
  // strings Claude Code later runs through a shell (always inside double
  // quotes). Reject only characters active INSIDE double quotes.
  if (/["`$\n\r]/.test(configDir)) {
    process.stderr.write(c.red(`config-dir contains shell-unsafe characters and was refused: ${configDir}\n`));
    return 2;
  }
  // The same hook command string also interpolates the EAP checkout dir
  // (REPO_ROOT → HOOK_DISPATCH) and the node binary path, in the same
  // double-quoted shell context — refuse shell-active characters there too.
  for (const [label, val] of [['EAP repo dir', REPO_ROOT], ['node binary path', process.execPath]]) {
    if (/["`$\n\r]/.test(val)) {
      process.stderr.write(c.red(`${label} contains shell-unsafe characters and was refused: ${val}\n`));
      return 2;
    }
  }

  const ctx = {
    opts, configDir, configDirExplicit,
    say: (s) => process.stdout.write(c.cyan(s) + '\n'),
    note: (s) => process.stdout.write(c.dim(s) + '\n'),
    warn: (s) => process.stderr.write(c.red(s) + '\n'),
    ok: (s) => process.stdout.write(c.green(s) + '\n'),
    results: { installed: [], planned: [], failed: [], dryRun: [] },
  };

  if (opts.uninstall) { uninstall(ctx); return 0; }

  ctx.say('EAP installer');
  ctx.note(`  repo: ${REPO_ROOT}`);
  ctx.note(`  layers: Signal${opts.lean ? ' + Lean' : ''}${opts.runtime ? ' + Runtime' : ''}${opts.context ? ' + Context' : ''}`);
  if (opts.dryRun) ctx.note('  (dry run — nothing will be written)');
  process.stdout.write('\n');

  const explicit = (id) => opts.only.includes(id);
  const want = (id) => opts.only.length === 0 || explicit(id);

  for (const prov of PROVIDERS) {
    if (!want(prov.id)) continue;
    // Auto-detect run: soft providers require explicit --only; others must be
    // detected. With --only the user opts in explicitly, bypassing detection.
    if (!explicit(prov.id)) {
      if (prov.soft) continue;
      if (!detectMatch(prov.detect)) continue;
    }
    // Backstop: an unexpected throw from one provider's install (e.g. an
    // unwritable target the guarded writes did not already catch) records a
    // clean per-agent failure and moves on — it never aborts the whole run.
    try {
      if (prov.wired) installClaude(ctx);
      else if (prov.native) { installSignalNative(ctx, prov); installMcpNative(ctx, prov); }
      else planProvider(ctx, prov);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      ctx.warn(`  ${prov.label} install failed: ${msg}`);
      ctx.results.failed.push([prov.id, msg]);
    }
    process.stdout.write('\n');
  }

  // Summary.
  ctx.say('EAP done');
  if (ctx.results.dryRun.length) { process.stdout.write('  would install (dry run — nothing written):\n'); for (const a of ctx.results.dryRun) process.stdout.write(`    • ${a}\n`); }
  if (ctx.results.installed.length) { ctx.ok('  installed (claude = all 3 layers; others = EAP-Signal):'); for (const a of ctx.results.installed) process.stdout.write(`    • ${a}\n`); }
  if (ctx.results.planned.length) { process.stdout.write('  planned (detected, manual):\n'); for (const a of ctx.results.planned) process.stdout.write(`    • ${a}\n`); }
  if (ctx.results.failed.length) { ctx.warn('  failed:'); for (const [id, why] of ctx.results.failed) process.stderr.write(`    • ${id} — ${why}\n`); }
  if (!ctx.results.installed.length && !ctx.results.planned.length && !ctx.results.failed.length && !ctx.results.dryRun.length) {
    process.stdout.write('  nothing detected. run --list to see the roster, or --only <agent> to force a target.\n');
  }
  process.stdout.write('\n');
  ctx.note(`  uninstall: node bin/eap-install.mjs --uninstall${configDirExplicit ? ` --config-dir ${configDir}` : ''}`);
  ctx.note('  update:    eap update   (or: node bin/eap-install.mjs update)');

  // Record checkout path + HEAD sha so later `eap update` can find this install.
  if (!opts.dryRun && ctx.results.installed.length) {
    try {
      let sha = null;
      try {
        sha = child_process.execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: REPO_ROOT, encoding: 'utf8', timeout: 5_000,
        }).trim();
      } catch { /* non-git checkout */ }
      writeInstallState({ root: REPO_ROOT, sha });
      ctx.note('  state:     ~/.eap/install-state.json');
    } catch { /* best-effort */ }
  }

  return ctx.results.failed.length && !ctx.results.installed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
