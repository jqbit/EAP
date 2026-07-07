#!/usr/bin/env node
// EAP — unified installer. Wires all three EAP layers into an AI coding agent in
// one command:
//
//   1. EAP-Voice   — the always-on output-compression rule, written as a managed
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
  upsertFencedBlock, stripFencedBlock, atomicWrite,
} from './lib/settings.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// bin/eap-install.mjs -> repo root is one level up.
const REPO_ROOT = path.resolve(__dirname, '..');

// Absolute paths to the two MCP server entrypoints and the voice rule + hook.
const RUNTIME_MCP = path.join(REPO_ROOT, 'layers', 'eap-runtime', 'src', 'mcp.mjs');
const CONTEXT_MCP = path.join(REPO_ROOT, 'layers', 'eap-context', 'src', 'eap_context', 'mcp.py');
const VOICE_RULE = path.join(REPO_ROOT, 'layers', 'eap-voice', 'EAP-VOICE.md');
const HOOK_DISPATCH = path.join(REPO_ROOT, 'src', 'hooks', 'eap-dispatch.mjs');

// Managed-block markers (Voice rule) and the hook idempotency marker.
const VOICE_BEGIN = '<!-- eap-voice:begin -->';
const VOICE_END = '<!-- eap-voice:end -->';
const HOOK_MARKER = 'eap-dispatch';

// Claude Code hook events EAP wires (see src/hooks/eap-dispatch.mjs).
const HOOK_EVENTS = [
  { event: 'SessionStart', matcher: null, timeout: 10 },
  { event: 'PreToolUse', matcher: 'Read|Grep|Glob', timeout: 5 },
  { event: 'PostToolUse', matcher: null, timeout: 10 },
  { event: 'PreCompact', matcher: null, timeout: 10 },
];

// ── Provider roster ─────────────────────────────────────────────────────────
// The same 35-provider id/label/detect matrix as the TLDR installer, reused as
// the EAP roster. `wired: true` marks a provider EAP installs END-TO-END today;
// every other row is detected and reported as "planned" — no false claims.
const PROVIDERS = [
  { id: 'claude',     label: 'Claude Code',        detect: 'command:claude', wired: true },
  { id: 'gemini',     label: 'Gemini CLI',         detect: 'command:gemini' },
  { id: 'opencode',   label: 'opencode',           detect: 'command:opencode' },
  { id: 'openclaw',   label: 'OpenClaw',           detect: 'command:openclaw||dir:$HOME/.openclaw/workspace' },
  { id: 'hermes',     label: 'Hermes Agent',       detect: 'command:hermes' },
  { id: 'codex',      label: 'Codex CLI',          detect: 'command:codex' },
  { id: 'cursor',     label: 'Cursor',             detect: 'command:cursor||macapp:Cursor' },
  { id: 'windsurf',   label: 'Windsurf',           detect: 'command:windsurf||macapp:Windsurf' },
  { id: 'cline',      label: 'Cline',              detect: 'vscode-ext:cline' },
  { id: 'continue',   label: 'Continue',           detect: 'vscode-ext:continue.continue||vscode-ext:continue' },
  { id: 'kilo',       label: 'Kilo Code',          detect: 'vscode-ext:kilocode' },
  { id: 'roo',        label: 'Roo Code',           detect: 'vscode-ext:roo||vscode-ext:rooveterinaryinc.roo-cline||cursor-ext:roo' },
  { id: 'augment',    label: 'Augment Code',       detect: 'vscode-ext:augment||jetbrains-plugin:augment' },
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
  { id: 'antigravity',label: 'Google Antigravity', detect: 'dir:$HOME/.gemini/antigravity', soft: true },
];

// ── argv ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    help: false, listOnly: false, dryRun: false, uninstall: false,
    nonInteractive: false, noColor: false, force: false,
    runtime: true, context: true, tui: false, yes: false,
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
      case '--tui': opts.tui = true; break;
      case '-y': case '--yes': opts.yes = true; break;
      case '--': break;
      case '--only': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) die('error: --only requires an agent id (see --list)');
        opts.only.push(v === 'aider' ? 'aider-desk' : v);
        break;
      }
      case '--config-dir': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) die('error: --config-dir requires a path');
        opts.configDir = expandHome(v);
        break;
      }
      default: die(`error: unknown flag: ${a}\nrun 'eap-install --help' for usage`);
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
// The exact commands EAP registers. eap-context receives the project root as
// argv[1] (process.cwd() at install time — the project the MCP will index).
function mcpServers(opts, projectRoot) {
  const out = {};
  if (opts.runtime) out['eap-runtime'] = { type: 'stdio', command: 'node', args: [RUNTIME_MCP] };
  if (opts.context) out['eap-context'] = { type: 'stdio', command: 'python3', args: [CONTEXT_MCP, projectRoot] };
  return out;
}

// ── Claude Code install (END-TO-END) ────────────────────────────────────────
function installClaude(ctx) {
  const { opts, configDir, say, note, ok, warn, results } = ctx;
  const projectRoot = process.cwd();
  const claudeMd = path.join(configDir, 'CLAUDE.md');
  const settingsPath = path.join(configDir, 'settings.json');
  const mcpPath = path.join(configDir, '.mcp.json');
  const eapConfPath = path.join(configDir, '.eap.json');
  const servers = mcpServers(opts, projectRoot);
  const serverNames = Object.keys(servers);
  const node = process.execPath;
  // MCP mechanism: prefer `claude mcp add` when the CLI is present AND we are
  // targeting the default config location; when the user pins --config-dir (or
  // the CLI is absent) write the .mcp.json entry directly so the install is
  // self-contained and reproducible.
  const useCli = !ctx.configDirExplicit && hasCmd('claude');

  say('→ Claude Code — installing all three EAP layers');

  // 1. Voice rule.
  let voiceBody;
  try { voiceBody = '# EAP-Voice — verdict-first output\n\n' + fs.readFileSync(VOICE_RULE, 'utf8').trimEnd(); }
  catch (e) { voiceBody = null; warn(`  cannot read Voice rule (${VOICE_RULE}): ${e.message}`); }

  if (opts.dryRun) {
    note(`  [1/3] Voice: write managed ${VOICE_BEGIN} block into ${claudeMd}`);
    note(`  [2/3] MCP: register ${serverNames.join(' + ') || '(none — both disabled)'} via ${useCli ? '`claude mcp add`' : `${mcpPath} mcpServers`}`);
    for (const [name, s] of Object.entries(servers)) note(`         ${name}: ${s.command} ${s.args.join(' ')}`);
    note(`  [3/3] Hooks: wire ${HOOK_EVENTS.map((h) => h.event).join(', ')} into ${settingsPath}`);
    note(`         command: "${node}" "${HOOK_DISPATCH}" <Event> "${eapConfPath}"`);
    note(`  would write layer flags to ${eapConfPath}`);
    results.dryRun.push('claude');
    return;
  }

  // 1. Voice rule → CLAUDE.md (managed marker-fenced block).
  if (voiceBody != null) {
    const existing = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : null;
    const next = upsertFencedBlock(existing, VOICE_BEGIN, VOICE_END, voiceBody);
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    backupOnce(claudeMd);
    // atomicWrite (temp + rename) is symlink-safe, unlike fs.writeFileSync which
    // would follow a planted CLAUDE.md symlink and write through to its target.
    atomicWrite(claudeMd, next, 0o644);
    ok(`  [1/3] Voice rule written to ${claudeMd}`);
  }

  // 2. MCP servers.
  if (serverNames.length === 0) {
    note('  [2/3] MCP: both servers disabled (--no-runtime --no-context) — skipped');
  } else if (useCli) {
    let allOk = true;
    for (const [name, s] of Object.entries(servers)) {
      const r = child_process.spawnSync('claude', ['mcp', 'add', name, '--', s.command, ...s.args], { stdio: 'inherit' });
      if ((r.status || 0) !== 0) { allOk = false; warn(`  claude mcp add ${name} failed`); }
    }
    if (allOk) ok(`  [2/3] MCP registered via 'claude mcp add': ${serverNames.join(', ')}`);
  } else {
    const cfg = readSettings(mcpPath);
    if (cfg === null) { warn(`  ${mcpPath} unparseable — skipping MCP registration`); results.failed.push(['claude-mcp', 'mcp file unparseable']); }
    else {
      if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
      for (const [name, s] of Object.entries(servers)) cfg.mcpServers[name] = s;
      backupOnce(mcpPath);
      writeSettings(mcpPath, cfg);
      ok(`  [2/3] MCP registered in ${mcpPath}: ${serverNames.join(', ')}`);
    }
  }

  // 3. Hooks → settings.json.
  const settings = readSettings(settingsPath);
  if (settings === null) { warn(`  ${settingsPath} unparseable — skipping hook wiring`); results.failed.push(['claude-hooks', 'settings.json unparseable']); }
  else {
    backupOnce(settingsPath);
    for (const { event, matcher, timeout } of HOOK_EVENTS) {
      addCommandHook(settings, event, {
        command: `"${node}" "${HOOK_DISPATCH}" ${event} "${eapConfPath}"`,
        marker: HOOK_MARKER, matcher: matcher || undefined, timeout,
      });
    }
    validateHookFields(settings, warn);
    writeSettings(settingsPath, settings);
    ok(`  [3/3] Hooks wired in ${settingsPath}: ${HOOK_EVENTS.map((h) => h.event).join(', ')}`);
  }

  // Layer flags for the dispatcher (runtime/context enable state + repo root).
  writeSettings(eapConfPath, { root: REPO_ROOT, runtime: opts.runtime, context: opts.context, version: 1 });

  results.installed.push('claude');
}

function backupOnce(p) {
  const bak = p + '.eap.bak';
  if (fs.existsSync(p) && !fs.existsSync(bak)) {
    try { fs.copyFileSync(p, bak, fs.constants.COPYFILE_EXCL); } catch { /* pre-existing / symlink */ }
  }
}

// ── Planned providers (detected, honestly not wired) ────────────────────────
function planProvider(ctx, prov) {
  const { note } = ctx;
  note(`→ ${prov.label} detected — EAP wiring PLANNED (not yet end-to-end).`);
  note('  Today EAP is wired end-to-end for Claude Code only. For this agent you can:');
  note(`    • Voice: paste ${VOICE_RULE} into its always-on rules/memory file.`);
  note(`    • MCP:   add eap-runtime (node ${RUNTIME_MCP}) and eap-context`);
  note(`             (python3 ${CONTEXT_MCP} <project-root>) to its MCP config.`);
  ctx.results.planned.push(prov.id);
}

// ── uninstall (Claude Code) ─────────────────────────────────────────────────
function uninstall(ctx) {
  const { opts, configDir, say, note, ok, warn } = ctx;
  say('EAP uninstall (Claude Code)');
  if (opts.dryRun) note('  (dry run — nothing will be removed)');

  const claudeMd = path.join(configDir, 'CLAUDE.md');
  const settingsPath = path.join(configDir, 'settings.json');
  const mcpPath = path.join(configDir, '.mcp.json');
  const eapConfPath = path.join(configDir, '.eap.json');
  const useCli = !ctx.configDirExplicit && hasCmd('claude');

  // 1. Voice block.
  if (fs.existsSync(claudeMd)) {
    const { text, stripped } = stripFencedBlock(fs.readFileSync(claudeMd, 'utf8'), VOICE_BEGIN, VOICE_END);
    if (stripped && !opts.dryRun) {
      if (text === '') { try { fs.unlinkSync(claudeMd); } catch { /* best effort */ } }
      else atomicWrite(claudeMd, text, 0o644);  // symlink-safe, matches install
    }
    if (stripped) ok(text === '' ? `  removed ${claudeMd}` : `  stripped Voice block from ${claudeMd}`);
  }

  // 2. MCP servers.
  if (useCli) {
    for (const name of ['eap-runtime', 'eap-context']) {
      if (!opts.dryRun) child_process.spawnSync('claude', ['mcp', 'remove', name], { stdio: 'ignore' });
    }
    ok('  removed MCP servers via `claude mcp remove`');
  } else if (fs.existsSync(mcpPath)) {
    const cfg = readSettings(mcpPath);
    if (cfg && cfg.mcpServers) {
      let removed = 0;
      for (const name of ['eap-runtime', 'eap-context']) if (cfg.mcpServers[name]) { delete cfg.mcpServers[name]; removed++; }
      if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
      if (!opts.dryRun) writeSettings(mcpPath, cfg);
      ok(`  removed ${removed} MCP server entr${removed === 1 ? 'y' : 'ies'} from ${mcpPath}`);
    }
  }

  // 3. Hooks.
  if (fs.existsSync(settingsPath)) {
    const settings = readSettings(settingsPath);
    if (settings) {
      const removed = removeCommandHooks(settings, HOOK_MARKER);
      validateHookFields(settings, warn);
      if (!opts.dryRun) writeSettings(settingsPath, settings);
      ok(`  removed ${removed} EAP hook entr${removed === 1 ? 'y' : 'ies'} from ${settingsPath}`);
    }
  }

  // Layer-flags file.
  if (fs.existsSync(eapConfPath) && !opts.dryRun) { try { fs.unlinkSync(eapConfPath); } catch { /* best effort */ } }

  process.stdout.write('\n');
  ok('uninstall done.');
}

// ── --list ──────────────────────────────────────────────────────────────────
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function printList(noColor) {
  const c = makeChalk(noColor);
  const wired = PROVIDERS.filter((p) => p.wired).length;
  process.stdout.write(c.cyan('EAP provider matrix') + '\n\n');
  process.stdout.write(`  ${pad('ID', 13)} ${pad('AGENT', 22)} STATUS\n`);
  process.stdout.write(`  ${pad('--', 13)} ${pad('-----', 22)} ------\n`);
  for (const p of PROVIDERS) {
    const status = p.wired ? c.green('end-to-end') : c.dim('planned');
    const soft = p.soft ? c.dim(' (soft-detect)') : '';
    process.stdout.write(`  ${pad(p.id, 13)} ${pad(p.label, 22)} ${status}${soft}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(c.dim(`  ${wired} provider wired end-to-end (Claude Code); ${PROVIDERS.length - wired} detected + planned.\n`));
  process.stdout.write(c.dim('  Planned providers are detected and given a manual plan — never silently claimed as wired.\n'));
  process.stdout.write(c.dim('  Layers: Voice (always-on rule) + eap-runtime MCP + eap-context MCP + hook dispatcher.\n'));
}

// ── help ────────────────────────────────────────────────────────────────────
function printHelp() {
  process.stdout.write(`eap-install — wire the three EAP layers into your AI coding agent.

USAGE
  node bin/eap-install.mjs [flags]

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
  --uninstall, -u        Remove the EAP Voice block, MCP entries, and hooks.
  --non-interactive      Never prompt; use defaults (skips the TUI).
  --no-color             Disable ANSI colors.
  --force                Reserved (installs are idempotent; re-runs are safe).
  -h, --help             Show this help.

WHAT GETS INSTALLED (Claude Code, end-to-end)
  1. EAP-Voice   -> managed block in <configDir>/CLAUDE.md
  2. eap-runtime -> node   ${RUNTIME_MCP}
     eap-context -> python3 ${CONTEXT_MCP} <project-root>
  3. hooks       -> SessionStart / PreToolUse / PostToolUse / PreCompact in
                    <configDir>/settings.json, running src/hooks/eap-dispatch.mjs

Every other provider is detected and reported as "planned" — EAP does not claim
to wire an agent it has not implemented end-to-end.
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
      const layers0 = 'Voice' + (opts.runtime ? ' + Runtime' : '') + (opts.context ? ' + Context' : '');
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

    // 2. Layer curation. Voice is always on; Runtime/Context are optional MCP
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
    const layers = 'Voice' + (opts.runtime ? ' + Runtime' : '') + (opts.context ? ' + Context' : '');
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
  const opts = parseArgs(process.argv.slice(2));
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
  ctx.note(`  layers: Voice${opts.runtime ? ' + Runtime' : ''}${opts.context ? ' + Context' : ''}`);
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
    if (prov.wired) installClaude(ctx);
    else planProvider(ctx, prov);
    process.stdout.write('\n');
  }

  // Summary.
  ctx.say('EAP done');
  if (ctx.results.dryRun.length) { process.stdout.write('  would install (dry run — nothing written):\n'); for (const a of ctx.results.dryRun) process.stdout.write(`    • ${a}\n`); }
  if (ctx.results.installed.length) { ctx.ok('  installed (end-to-end):'); for (const a of ctx.results.installed) process.stdout.write(`    • ${a}\n`); }
  if (ctx.results.planned.length) { process.stdout.write('  planned (detected, manual):\n'); for (const a of ctx.results.planned) process.stdout.write(`    • ${a}\n`); }
  if (ctx.results.failed.length) { ctx.warn('  failed:'); for (const [id, why] of ctx.results.failed) process.stderr.write(`    • ${id} — ${why}\n`); }
  if (!ctx.results.installed.length && !ctx.results.planned.length && !ctx.results.failed.length && !ctx.results.dryRun.length) {
    process.stdout.write('  nothing detected. run --list to see the roster, or --only <agent> to force a target.\n');
  }
  process.stdout.write('\n');
  ctx.note(`  uninstall: node bin/eap-install.mjs --uninstall${configDirExplicit ? ` --config-dir ${configDir}` : ''}`);

  return ctx.results.failed.length && !ctx.results.installed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
