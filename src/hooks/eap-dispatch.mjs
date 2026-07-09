// EAP — one hook dispatcher, fanned out by event. Node built-ins only.
//
// Wired into the agent's hook settings by bin/eap-install.mjs. One file handles
// every event so a single settings.json edit covers the whole lifecycle:
//
//   SessionStart  -> emit the Signal rules, (if Runtime installed) the last
//                    session resume snapshot, and a Context-graph availability
//                    note.
//   PreToolUse    -> nudge toward eap_graph_query before a large raw read; with
//                    the opt-in .eap/routing-enforce flag, deny raw network /
//                    oversize-read paths and redirect to the eap_* equivalent.
//   PostToolUse   -> offload oversized tool output behind a searchable pointer.
//   Stop          -> record a turn-end event in the Runtime session log.
//   PreCompact    -> persist a priority-tiered Runtime session snapshot.
//
// INVARIANT: a hook must never crash the agent. Every handler is best-effort and
// silent-failing; `dispatch` is a pure function (effects only through injected
// deps) so it is fully unit-testable, and the thin stdio wrapper below always
// exits 0 no matter what.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as state from './eap-state.mjs';

// Kept local (not imported from store.mjs) so the pure dispatcher carries no
// node:sqlite dependency; the wrapper injects the real store. Mirrors
// layers/eap-runtime/src/store.mjs OFFLOAD_THRESHOLD_BYTES (~100 KB).
export const DEFAULT_OFFLOAD_THRESHOLD = 100 * 1024;

// ── pure helpers ────────────────────────────────────────────────────────────
function extractToolOutput(input) {
  if (!input || typeof input !== 'object') return '';
  const r = input.tool_response ?? input.tool_output ?? input.output ?? input.stdout;
  if (r == null) return '';
  return typeof r === 'string' ? r : JSON.stringify(r);
}

function extractSource(input) {
  if (!input || typeof input !== 'object') return 'tool';
  const tool = typeof input.tool_name === 'string' ? input.tool_name : 'tool';
  const ti = input.tool_input;
  const fp = ti && typeof ti === 'object' ? (ti.file_path || ti.path || ti.pattern) : null;
  return fp ? `${tool}:${fp}` : tool;
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Cat', 'View']);

// ── routing deny mode (opt-in via the .eap/routing-enforce flag file) ───────
// Reason strings are documented in layers/eap-runtime/README.md ("Routing deny
// mode"). Keep the two in sync.
export const DENY_REASONS = {
  bash: 'EAP routing-enforce: network CLIs (curl/wget) are denied in this project. '
    + 'Use eap_fetch instead — it retrieves the URL through the SSRF-hardened '
    + 'allowlist and returns reduced text or a searchable pointer.',
  webfetch: 'EAP routing-enforce: WebFetch is denied in this project. '
    + 'Use eap_fetch (inline text or pointer) or eap_fetch_and_index (searchable '
    + 'pointer + vocabulary) instead.',
  read: (p, bytes, threshold) => `EAP routing-enforce: raw Read of ${p} (${bytes} bytes) exceeds the `
    + `${threshold}-byte offload threshold. Use eap_execute (extract just the facts in a subprocess) `
    + `or eap_index + eap_search (lossless chunk retrieval) instead.`,
};

// Pure deny decision for PreToolUse under routing-enforce. `fileSize` is an
// injected (path) => bytes|null probe so this stays filesystem-free in tests.
// Returns a reason string, or null to fall through to the nudge behaviour.
export function routingDeny(input, { fileSize, threshold = DEFAULT_OFFLOAD_THRESHOLD } = {}) {
  if (!input || typeof input !== 'object') return null;
  const tool = input.tool_name;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (tool === 'WebFetch') return DENY_REASONS.webfetch;
  if (tool === 'Bash') {
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    if (/\bcurl\b|\bwget\b/.test(cmd)) return DENY_REASONS.bash;
    return null;
  }
  if (tool === 'Read' && typeof fileSize === 'function') {
    const p = ti.file_path || ti.path;
    if (typeof p !== 'string' || !p) return null;
    const bytes = fileSize(p);
    if (Number.isFinite(bytes) && bytes > threshold) return DENY_REASONS.read(p, bytes, threshold);
  }
  return null;
}

// ── pure dispatcher ─────────────────────────────────────────────────────────
// (event, parsed-hook-input, deps) -> result object. Always returns an object
// carrying at least `{ event }`; never throws. deps:
//   signalRules       string  — the EAP-Signal rule text (SessionStart)
//   runtime          { store, session } | null — injected Runtime modules
//   contextAvailable boolean — is the eap-context graph MCP registered?
//   threshold        number  — offload byte threshold (PostToolUse)
//   now              () => number — injected clock (deterministic in tests)
export async function dispatch(event, input, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => 0;
  const runtime = deps.runtime || null;

  const safe = (fn) => { try { return fn() || { event }; } catch { return { event }; } };

  switch (event) {
    case 'SessionStart':
      return safe(() => {
        const parts = [];
        // Signal rules are emitted here ONLY when they are not already a static
        // managed block in the agent's memory file (deps.signalStatic). Every
        // current install path writes the static block, so the wrapper passes
        // signalStatic:true and this is skipped — killing the double-injection.
        if (deps.signalRules && !deps.signalStatic) parts.push(String(deps.signalRules));
        // Active-level reminders — only when a non-default level is set, so a
        // plain `full` session pays nothing (the static block already carries it).
        const sig = deps.readMode ? deps.readMode('signal') : 'full';
        const lean = deps.readMode ? deps.readMode('lean') : 'full';
        if (sig !== 'full') parts.push(`EAP-Signal active level: **${sig}**${sig === 'off' ? ' — compression paused.' : '.'}`);
        if (lean !== 'full') parts.push(`EAP-Lean active level: **${lean}**${lean === 'off' ? ' — ladder paused.' : '.'}`);
        if (runtime && runtime.session) {
          const snap = runtime.session.restore();
          if (snap && snap.body) parts.push('## EAP-Runtime resume (last session)\n\n' + snap.body);
        }
        if (deps.contextAvailable) {
          parts.push('EAP-Context symbol-graph MCP is available — call eap_graph_query for '
            + 'file:line pointers instead of reading whole files into context.');
        }
        return parts.length ? { event, additionalContext: parts.join('\n\n') } : { event };
      });

    case 'UserPromptSubmit':
      return safe(() => {
        const prompt = input && typeof input === 'object'
          ? (input.prompt || input.user_prompt || input.message || '') : '';
        // Whole-message stop phrases revert to default (exact-match guard so
        // "add a normal mode toggle" never disables a layer mid-task).
        const deact = deps.parseDeactivate ? deps.parseDeactivate(prompt) : null;
        if (deact) {
          if (deps.clearMode) {
            if (deact === 'both' || deact === 'lean') deps.clearMode('lean');
            if (deact === 'both' || deact === 'signal') deps.clearMode('signal');
          }
          const which = deact === 'both' ? 'EAP-Signal + EAP-Lean' : (deact === 'lean' ? 'EAP-Lean' : 'EAP-Signal');
          return { event, additionalContext: `${which} reverted to default (full).` };
        }
        const sw = deps.parseSwitch ? deps.parseSwitch(prompt) : null;
        if (sw && sw.mode) {
          if (deps.setMode) deps.setMode(sw.kind, sw.mode);
          const layer = sw.kind === 'lean' ? 'EAP-LEAN' : 'EAP-SIGNAL';
          return { event, additionalContext: `${layer} LEVEL CHANGED — level: ${sw.mode}. Apply it every response until changed.` };
        }
        if (sw) { // bare `/eap lean` or `/eap signal` — report current level
          const cur = deps.readMode ? deps.readMode(sw.kind) : 'full';
          return { event, additionalContext: `${sw.kind === 'lean' ? 'EAP-Lean' : 'EAP-Signal'} active level: ${cur}.` };
        }
        // Per-turn reinforcement only for non-default active levels.
        const notes = [];
        const sig = deps.readMode ? deps.readMode('signal') : 'full';
        const lean = deps.readMode ? deps.readMode('lean') : 'full';
        if (sig !== 'full') notes.push(`Signal:${sig}`);
        if (lean !== 'full') notes.push(`Lean:${lean}`);
        return notes.length ? { event, additionalContext: `EAP active — ${notes.join(' ')}.` } : { event };
      });

    case 'SubagentStart':
      return safe(() => {
        // Subagents do not inherit the parent's memory-file block, so inject the
        // rule bodies here, scoped to the active level (ponytail issue #252).
        const sig = deps.readMode ? deps.readMode('signal') : 'full';
        const lean = deps.readMode ? deps.readMode('lean') : 'full';
        const parts = [];
        if (deps.signalRules && sig !== 'off') {
          parts.push((sig !== 'full' ? `EAP-Signal — apply the **${sig}** level:\n\n` : '') + String(deps.signalRules));
        }
        if (deps.leanRules && lean !== 'off') {
          parts.push((lean !== 'full' ? `EAP-Lean — apply the **${lean}** level:\n\n` : '') + String(deps.leanRules));
        }
        return parts.length ? { event, additionalContext: parts.join('\n\n') } : { event };
      });

    case 'PreToolUse':
      return safe(() => {
        // Opt-in routing deny mode: when the project's .eap/routing-enforce flag
        // exists (deps.routingEnforce), hard-deny the raw network/oversize paths
        // and redirect to the eap_* equivalent. Default: nudge behaviour only.
        if (deps.routingEnforce) {
          const reason = routingDeny(input, { fileSize: deps.fileSize, threshold: deps.threshold });
          if (reason) return { event, deny: reason };
        }
        if (!deps.contextAvailable) return { event };
        const tool = input && typeof input === 'object' ? input.tool_name : null;
        if (!READ_TOOLS.has(tool)) return { event };
        return {
          event,
          additionalContext: 'EAP graph-nudge: before this raw read, consider eap_graph_query '
            + '(or eap_graph_neighbors) — it returns a compact subgraph with file:line pointers '
            + 'instead of dumping whole files into context.',
        };
      });

    case 'PostToolUse':
      return safe(() => {
        if (!runtime || !runtime.store) return { event };
        const content = extractToolOutput(input);
        if (!content) return { event };
        const threshold = Number.isFinite(deps.threshold) ? deps.threshold : DEFAULT_OFFLOAD_THRESHOLD;
        const source = extractSource(input);
        const res = runtime.store.offload(source, content, { threshold, createdAt: now() });
        if (res.inline) return { event, offload: res };
        if (runtime.session) {
          try { runtime.session.append({ ts: now(), kind: 'tool', summary: `offloaded ${source} (${res.bytes} bytes) -> ${res.pointer}` }); } catch { /* best effort */ }
        }
        return { event, offload: res, additionalContext: res.hint };
      });

    case 'Stop':
      return safe(() => {
        // Turn boundary: record a turn-end event in the session log (same
        // mechanism as SessionStart/PreCompact; tier-3 ambient kind 'turn').
        if (!runtime || !runtime.session) return { event };
        runtime.session.append({ ts: now(), kind: 'turn', summary: 'turn end' });
        return { event, logged: true };
      });

    case 'PreCompact':
      return safe(() => {
        if (!runtime || !runtime.session) return { event };
        const snap = runtime.session.snapshot({ ts: now() });
        return { event, snapshot: snap };
      });

    default:
      return { event };
  }
}

// ── stdio wrapper (only runs when invoked directly) ─────────────────────────
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function resolveRepoRoot() {
  // src/hooks/eap-dispatch.mjs -> repo root is two levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function loadConfig(configPath, repoRoot) {
  const cfg = { root: repoRoot, runtime: true, context: true };
  try {
    if (configPath && fs.existsSync(configPath)) Object.assign(cfg, JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch { /* defaults */ }
  return cfg;
}

async function buildRuntime(cfg) {
  if (!cfg.runtime) return null;
  try {
    const base = path.join(cfg.root, 'layers', 'eap-runtime', 'src');
    const { RuntimeStore } = await import(pathToFileURL(path.join(base, 'store.mjs')).href);
    const { SessionLog } = await import(pathToFileURL(path.join(base, 'session.mjs')).href);
    const dbPath = process.env.EAP_DB || path.join(process.cwd(), '.eap', 'runtime.db');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const store = new RuntimeStore(dbPath);
    const session = new SessionLog(store);
    return { store, session };
  } catch { return null; }
}

async function run() {
  let runtime = null;
  try {
    const event = process.argv[2] || '';
    const configPath = process.argv[3] || process.env.EAP_HOOK_CONFIG || '';
    const repoRoot = resolveRepoRoot();
    const cfg = loadConfig(configPath, repoRoot);

    let input = {};
    const raw = readStdin();
    if (raw && raw.trim()) { try { input = JSON.parse(raw); } catch { input = {}; } }
    const ev = event || input.hook_event_name || '';

    let signalRules = '';
    let leanRules = '';
    // Signal body is needed for SessionStart (level notes) and SubagentStart
    // (full inject); Lean body only for SubagentStart.
    if (ev === 'SessionStart' || ev === 'SubagentStart') {
      try { signalRules = fs.readFileSync(path.join(cfg.root, 'layers', 'eap-signal', 'EAP-SIGNAL.md'), 'utf8').trim(); } catch { /* optional */ }
    }
    if (ev === 'SubagentStart' && cfg.lean !== false) {
      try { leanRules = fs.readFileSync(path.join(cfg.root, 'layers', 'eap-lean', 'EAP-LEAN.md'), 'utf8').trim(); } catch { /* optional */ }
    }
    if (ev === 'SessionStart' || ev === 'PostToolUse' || ev === 'PreCompact' || ev === 'Stop') runtime = await buildRuntime(cfg);

    const result = await dispatch(ev, input, {
      signalRules,
      leanRules,
      // Installer writes Signal as a static managed block in the memory file, so
      // the hook must not re-emit it on SessionStart (avoids double-injection).
      signalStatic: cfg.signalStatic !== false,
      runtime,
      contextAvailable: !!cfg.context,
      readMode: state.readMode,
      setMode: state.setMode,
      clearMode: state.clearMode,
      parseSwitch: state.parseSwitch,
      parseDeactivate: state.parseDeactivate,
      // Routing deny mode is opt-in per project: the flag file lives under the
      // project's .eap/ dir (same root as runtime.db).
      routingEnforce: fs.existsSync(path.join(process.cwd(), '.eap', 'routing-enforce')),
      fileSize: (p) => { try { return fs.statSync(p).size; } catch { return null; } },
      now: () => Date.now(),
    });

    if (result && typeof result.deny === 'string' && result.deny) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: ev, permissionDecision: 'deny', permissionDecisionReason: result.deny },
      }) + '\n');
    } else if (result && typeof result.additionalContext === 'string' && result.additionalContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: ev, additionalContext: result.additionalContext },
      }) + '\n');
    }
  } catch { /* silent-fail invariant: a hook must never crash the agent */ }
  finally {
    try { runtime && runtime.store && runtime.store.close(); } catch { /* best effort */ }
    process.exit(0);
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) run();
