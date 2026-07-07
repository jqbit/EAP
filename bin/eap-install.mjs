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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// bin/eap-install.mjs -> repo root is one level up.
const REPO_ROOT = path.resolve(__dirname, '..');

// Absolute paths to the two MCP server entrypoints and the signal rule + hook.
const RUNTIME_MCP = path.join(REPO_ROOT, 'layers', 'eap-runtime', 'src', 'mcp.mjs');
const CONTEXT_MCP = path.join(REPO_ROOT, 'layers', 'eap-context', 'src', 'eap_context', 'mcp.py');
const SIGNAL_RULE = path.join(REPO_ROOT, 'layers', 'eap-signal', 'EAP-SIGNAL.md');
const HOOK_DISPATCH = path.join(REPO_ROOT, 'src', 'hooks', 'eap-dispatch.mjs');

// Managed-block markers (Signal rule) and the hook idempotency marker.
const SIGNAL_BEGIN = '<!-- eap-signal:begin -->';
const SIGNAL_END = '<!-- eap-signal:end -->';
// Legacy markers from before the EAP-Voice → EAP-Signal rename. Still recognized
// on UNINSTALL so an install made by an older build is cleaned up; never written.
const LEGACY_SIGNAL_BEGIN = '<!-- eap-voice:begin -->';
const LEGACY_SIGNAL_END = '<!-- eap-voice:end -->';

// Strip the current AND legacy managed blocks from a rules-file body.
function stripSignalBlocks(body) {
  let touched = false;
  let r = stripFencedBlock(body, SIGNAL_BEGIN, SIGNAL_END);
  touched = touched || r.stripped;
  r = stripFencedBlock(r.text, LEGACY_SIGNAL_BEGIN, LEGACY_SIGNAL_END);
  touched = touched || r.stripped;
  return { text: r.text, stripped: touched };
}
const HOOK_MARKER = 'eap-dispatch';

// Claude Code hook events EAP wires (see src/hooks/eap-dispatch.mjs).
const HOOK_EVENTS = [
  { event: 'SessionStart', matcher: null, timeout: 10 },
  { event: 'PreToolUse', matcher: 'Read|Grep|Glob', timeout: 5 },
  { event: 'PostToolUse', matcher: null, timeout: 10 },
  { event: 'PreCompact', matcher: null, timeout: 10 },
];

// ── Provider roster ─────────────────────────────────────────────────────────
// The id/label/detect matrix mirrored from the TLDR installer, reused as the
// EAP roster (37 rows). `wired: true` marks a provider EAP installs END-TO-END
// today (all three layers). A `native` field marks a provider that gets its
// EAP-Signal rule written natively into its global always-on rules file
// (`native.signal`), even though its MCP layers are not yet wired — reported as
// "signal", never "end-to-end". `native.signal: null` means the agent has no
// global rules file (per-repo only, e.g. cursor). Every remaining row is
// detected and reported as "planned" — no false claims.
//
// `native.signal` sentinels resolved by resolveNativeSignal(): `$HOME` (home dir),
// `$XDG_CONFIG_HOME` (env or ~/.config), `$HERMES_HOME` (env or ~/.hermes).
//
// `native.mcp` (present only on MCP-capable native agents) describes HOW to
// register the two EAP MCP servers for that agent (installMcpNative):
//   kind: 'cli-dashdash'  -> `<bin> mcp add <name> -- <command> <args…>`   (codex, grok)
//   kind: 'cli-hermes'    -> `<bin> mcp add <name> --command <command> --args <args…>` (hermes)
//   kind: 'json'          -> merge into a JSON/JSONC file at `file` under key `key`;
//                            shape 'command-args'         -> { command, args }  (cursor, antigravity)
//                            shape 'command-array-local'  -> { type:'local', command:[cmd,…args], enabled:true } (opencode)
// pi has NO native.mcp — Pi ships npm extensions, not MCP, so it stays Signal-only.
const PROVIDERS = [
  { id: 'claude',     label: 'Claude Code',        detect: 'command:claude', wired: true },
  { id: 'gemini',     label: 'Gemini CLI',         detect: 'command:gemini' },
  { id: 'opencode',   label: 'opencode',           detect: 'command:opencode', native: { signal: '$XDG_CONFIG_HOME/opencode/AGENTS.md', mcp: { kind: 'json', file: '$XDG_CONFIG_HOME/opencode/opencode.jsonc', key: 'mcp', shape: 'command-array-local' } } },
  { id: 'openclaw',   label: 'OpenClaw',           detect: 'command:openclaw||dir:$HOME/.openclaw/workspace' },
  { id: 'hermes',     label: 'Hermes Agent',       detect: 'command:hermes', native: { signal: '$HERMES_HOME/SOUL.md', mcp: { kind: 'cli-hermes', bin: 'hermes' } } },
  { id: 'codex',      label: 'Codex CLI',          detect: 'command:codex', native: { signal: '$HOME/.codex/AGENTS.md', mcp: { kind: 'cli-dashdash', bin: 'codex' } } },
  { id: 'pi',         label: 'Pi Coding Agent',    detect: 'command:pi', native: { signal: '$HOME/.pi/agent/AGENTS.md' } },
  { id: 'grok',       label: 'Grok Build CLI',     detect: 'command:grok', native: { signal: '$HOME/.grok/AGENTS.md', mcp: { kind: 'cli-dashdash', bin: 'grok' } } },
  { id: 'cursor',     label: 'Cursor',             detect: 'command:cursor||macapp:Cursor', native: { signal: null, mcp: { kind: 'json', file: '$HOME/.cursor/mcp.json', key: 'mcpServers', shape: 'command-args' } } },
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
  { id: 'antigravity',label: 'Google Antigravity', detect: 'dir:$HOME/.gemini/antigravity', soft: true, native: { signal: '$HOME/.gemini/config/AGENTS.md', mcp: { kind: 'json', file: '$HOME/.gemini/config/mcp_config.json', key: 'mcpServers', shape: 'command-args' } } },
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
// provider has no global rules file (native.signal === null, e.g. cursor).
function resolveNativeSignal(prov) {
  const spec = prov.native && prov.native.signal;
  if (!spec) return null; // null (per-repo only) or no native signal at all
  return resolveSentinelPath(spec);
}

// ── Claude Code install (END-TO-END) ────────────────────────────────────────
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

  // 1. Signal rule.
  const signalBody = buildSignalBody(warn);

  if (opts.dryRun) {
    note(`  [1/3] Signal: write managed ${SIGNAL_BEGIN} block into ${claudeMd}`);
    note(`  [2/3] MCP: register ${serverNames.join(' + ') || '(none — both disabled)'} via ${useCli ? '`claude mcp add`' : `${mcpPath} mcpServers`}`);
    for (const [name, s] of Object.entries(servers)) note(`         ${name}: ${s.command} ${s.args.join(' ')}`);
    note(`  [3/3] Hooks: wire ${HOOK_EVENTS.map((h) => h.event).join(', ')} into ${settingsPath}`);
    note(`         command: "${node}" "${HOOK_DISPATCH}" <Event> "${eapConfPath}"`);
    note(`  would write layer flags to ${eapConfPath}`);
    results.dryRun.push('claude');
    return;
  }

  // 1. Signal rule → CLAUDE.md (managed marker-fenced block). The write is guarded
  // so a read-only configDir records a clean failure and MCP/hooks are still
  // attempted rather than aborting the whole multi-agent run with a stack trace.
  if (signalBody != null) {
    const err = tryWrite(() => {
      const existing = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : null;
      const next = upsertFencedBlock(existing, SIGNAL_BEGIN, SIGNAL_END, signalBody);
      fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
      backupOnce(claudeMd);
      // atomicWrite (temp + rename) is symlink-safe, unlike fs.writeFileSync which
      // would follow a planted CLAUDE.md symlink and write through to its target.
      atomicWrite(claudeMd, next, 0o644);
    });
    if (err) { warn(`  [1/3] Signal write failed (${claudeMd}): ${err}`); results.failed.push(['claude-signal', err]); }
    else ok(`  [1/3] Signal rule written to ${claudeMd}`);
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
          marker: HOOK_MARKER, matcher: matcher || undefined, timeout,
        });
      }
      validateHookFields(settings, warn);
      writeSettings(settingsPath, settings);
    });
    if (err) { warn(`  [3/3] Hooks write failed (${settingsPath}): ${err}`); results.failed.push(['claude-hooks', err]); }
    else ok(`  [3/3] Hooks wired in ${settingsPath}: ${HOOK_EVENTS.map((h) => h.event).join(', ')}`);
  }

  // Layer flags for the dispatcher (runtime/context enable state + repo root).
  const flagsErr = tryWrite(() => writeSettings(eapConfPath, { root: REPO_ROOT, runtime: opts.runtime, context: opts.context, version: 1 }));
  if (flagsErr) { warn(`  layer-flags write failed (${eapConfPath}): ${flagsErr}`); results.failed.push(['claude-flags', flagsErr]); }

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

// ── Native EAP-Signal install (non-Claude AGENTS.md / SOUL.md agents) ─────────
// Writes the SAME managed <!-- eap-signal:begin --> … block installClaude writes,
// into the agent's global always-on rules file (native.signal). Signal ONLY — MCP
// registration for these agents is a separate, later step. For a per-repo agent
// (native.signal === null, e.g. cursor) there is no global file: print the
// per-repo note and record it handled.
function installSignalNative(ctx, prov) {
  const { opts, say, note, ok, warn, results } = ctx;
  const target = resolveNativeSignal(prov);

  // Per-repo only (cursor): no global rules file to write.
  if (target == null) {
    say(`→ ${prov.label} — EAP-Signal is per-repo (no global rules file)`);
    note('  cursor-agent only honors a per-project AGENTS.md; drop one carrying the');
    note(`  ${SIGNAL_BEGIN} block at each repo root you use it in.`);
    if (opts.dryRun) results.dryRun.push(prov.id);
    else results.installed.push(prov.id);
    return;
  }

  const signalBody = buildSignalBody(warn);
  say(`→ ${prov.label} — installing EAP-Signal (native)`);
  if (signalBody == null) { results.failed.push([prov.id, 'Signal rule unreadable']); return; }

  if (opts.dryRun) {
    note(`  Signal: write managed ${SIGNAL_BEGIN} block into ${target}`);
    results.dryRun.push(prov.id);
    return;
  }

  // Guarded write: a read-only rules dir (mkdtempSync EACCES / EROFS) records a
  // clean per-agent failure instead of aborting the whole multi-agent run.
  const err = tryWrite(() => {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const next = upsertFencedBlock(existing, SIGNAL_BEGIN, SIGNAL_END, signalBody);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    backupOnce(target);
    // atomicWrite (temp + rename) is symlink-safe — never write through a planted
    // rules-file symlink, matching installClaude.
    atomicWrite(target, next, 0o644);
  });
  if (err) { warn(`  Signal write failed for ${prov.label} (${target}): ${err}`); results.failed.push([prov.id, err]); return; }
  ok(`  Signal rule written to ${target}`);
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
    // `hermes mcp add` connects, discovers tools, then prompts "Enable all
    // tools? [Y/n]" on stdin. Under a non-interactive install that prompt has no
    // TTY and CANCELS — the CLI exits 0 but the server is NOT saved. Feed the
    // default "y" so the server persists with its tools enabled. codex/grok
    // (cli-dashdash) are non-interactive and keep inherited stdio.
    const spawnOpts = desc.kind === 'cli-hermes'
      ? { input: 'y\n', stdio: ['pipe', 'inherit', 'inherit'] }
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
    if (!opts.dryRun) writeSettings(file, cfg);
    ok(`  removed ${removed} EAP MCP entr${removed === 1 ? 'y' : 'ies'} from ${prov.label} (${file})`);
  }
}

// ── Planned providers (detected, honestly not wired) ────────────────────────
function planProvider(ctx, prov) {
  const { note } = ctx;
  note(`→ ${prov.label} detected — EAP wiring PLANNED (not yet end-to-end).`);
  note('  Today EAP is wired end-to-end for Claude Code only. For this agent you can:');
  note(`    • Signal: paste ${SIGNAL_RULE} into its always-on rules/memory file.`);
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

  // 1. Signal block.
  if (fs.existsSync(claudeMd)) {
    const { text, stripped } = stripSignalBlocks(fs.readFileSync(claudeMd, 'utf8'));
    if (stripped && !opts.dryRun) {
      if (text === '') { try { fs.unlinkSync(claudeMd); } catch { /* best effort */ } }
      else atomicWrite(claudeMd, text, 0o644);  // symlink-safe, matches install
    }
    if (stripped) ok(text === '' ? `  removed ${claudeMd}` : `  stripped Signal block from ${claudeMd}`);
  }

  // 2. MCP servers.
  if (useCli) {
    for (const name of ['eap-runtime', 'eap-context']) {
      if (!opts.dryRun) child_process.spawnSync('claude', ['mcp', 'remove', name], { stdio: 'ignore' });
    }
    ok('  removed MCP servers via `claude mcp remove`');
  } else if (fs.existsSync(mcpPath)) {
    const cfg = readSettings(mcpPath);
    if (isPlainObject(cfg) && cfg.mcpServers) {
      let removed = 0;
      for (const name of ['eap-runtime', 'eap-context']) if (cfg.mcpServers[name]) { delete cfg.mcpServers[name]; removed++; }
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

  // Native EAP-Signal blocks (codex/opencode/pi/grok/antigravity/hermes). Strip
  // exactly our fenced block from each agent's global rules file, preserving all
  // surrounding user content; delete the file only when nothing else remains.
  // cursor (native.signal === null) is per-repo — no global file to touch.
  for (const prov of PROVIDERS) {
    if (!prov.native) continue;
    const target = resolveNativeSignal(prov);
    if (target == null || !fs.existsSync(target)) continue;
    const { text, stripped } = stripSignalBlocks(fs.readFileSync(target, 'utf8'));
    if (!stripped) continue;
    if (!opts.dryRun) {
      if (text === '') { try { fs.unlinkSync(target); } catch { /* best effort */ } }
      else atomicWrite(target, text, 0o644); // symlink-safe, matches install
    }
    ok(text === '' ? `  removed ${target}` : `  stripped Signal block from ${prov.label} (${target})`);
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
    if (p.wired) status = c.green('end-to-end (all 3)');
    else if (p.native && p.native.mcp) status = c.green(p.native.signal === null ? 'signal(per-repo) + mcp' : 'signal + mcp');
    else if (p.native) status = c.green('signal');
    else status = c.dim('planned');
    const soft = p.soft ? c.dim(' (soft-detect)') : '';
    process.stdout.write(`  ${pad(p.id, 13)} ${pad(p.label, 22)} ${status}${soft}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(c.dim(`  ${wired} provider wired end-to-end (Claude Code, all 3 layers); ${signalMcp} with native EAP-Signal + both MCP servers; ${signalOnly} EAP-Signal only (no MCP); ${planned} detected + planned.\n`));
  process.stdout.write(c.dim('  "signal + mcp" = the always-on EAP-Signal rule AND both EAP MCP servers are registered natively; cursor is signal(per-repo).\n'));
  process.stdout.write(c.dim('  Planned providers are detected and given a manual plan — never silently claimed as wired.\n'));
  process.stdout.write(c.dim('  Layers: Signal (always-on rule) + eap-runtime MCP + eap-context MCP + hook dispatcher.\n'));
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
  --uninstall, -u        Remove the EAP Signal block, MCP entries, and hooks.
  --non-interactive      Never prompt; use defaults (skips the TUI).
  --no-color             Disable ANSI colors.
  --force                Reserved (installs are idempotent; re-runs are safe).
  -h, --help             Show this help.

WHAT GETS INSTALLED (Claude Code, end-to-end)
  1. EAP-Signal   -> managed block in <configDir>/CLAUDE.md
  2. eap-runtime -> node   ${RUNTIME_MCP}
     eap-context -> python3 ${CONTEXT_MCP} <project-root>
  3. hooks       -> SessionStart / PreToolUse / PostToolUse / PreCompact in
                    <configDir>/settings.json, running src/hooks/eap-dispatch.mjs

NATIVE AGENTS (EAP-Signal rule + both EAP MCP servers, registered natively)
  codex, grok        -> Signal rule + '<bin> mcp add … -- <cmd> <args>'
  hermes             -> Signal rule + 'hermes mcp add … --command <cmd> --args <args>'
  opencode           -> Signal rule + 'mcp' key in opencode.jsonc (type:local)
  cursor, antigravity-> MCP in ~/.cursor/mcp.json / ~/.gemini/config/mcp_config.json
                        (cursor's Signal rule is per-repo AGENTS.md, MCP is global)
  pi                 -> Signal rule only (Pi has no MCP; it uses npm extensions)
Every other provider is detected and reported as "planned" — EAP does not claim
to wire an agent it has not implemented. See --list for the full matrix.
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
      const layers0 = 'Signal' + (opts.runtime ? ' + Runtime' : '') + (opts.context ? ' + Context' : '');
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
    const layers = 'Signal' + (opts.runtime ? ' + Runtime' : '') + (opts.context ? ' + Context' : '');
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
  ctx.note(`  layers: Signal${opts.runtime ? ' + Runtime' : ''}${opts.context ? ' + Context' : ''}`);
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

  return ctx.results.failed.length && !ctx.results.installed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
