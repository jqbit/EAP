// EAP — one hook dispatcher, fanned out by event. Node built-ins only.
//
// Wired into the agent's hook settings by bin/eap-install.mjs. One file handles
// every event so a single settings.json edit covers the whole lifecycle:
//
//   SessionStart  -> emit the Voice rules, (if Runtime installed) the last
//                    session resume snapshot, and a Context-graph availability
//                    note.
//   PreToolUse    -> nudge toward eap_graph_query before a large raw read.
//   PostToolUse   -> offload oversized tool output behind a searchable pointer.
//   PreCompact    -> persist a priority-tiered Runtime session snapshot.
//
// INVARIANT: a hook must never crash the agent. Every handler is best-effort and
// silent-failing; `dispatch` is a pure function (effects only through injected
// deps) so it is fully unit-testable, and the thin stdio wrapper below always
// exits 0 no matter what.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ── pure dispatcher ─────────────────────────────────────────────────────────
// (event, parsed-hook-input, deps) -> result object. Always returns an object
// carrying at least `{ event }`; never throws. deps:
//   voiceRules       string  — the EAP-Voice rule text (SessionStart)
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
        if (deps.voiceRules) parts.push(String(deps.voiceRules));
        if (runtime && runtime.session) {
          const snap = runtime.session.restore();
          if (snap && snap.body) parts.push('## EAP-Runtime resume (last session)\n\n' + snap.body);
        }
        if (deps.contextAvailable) {
          parts.push('EAP-Context symbol-graph MCP is available — call eap_graph_query for '
            + 'file:line pointers instead of reading whole files into context.');
        }
        return { event, additionalContext: parts.join('\n\n') };
      });

    case 'PreToolUse':
      return safe(() => {
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

    let voiceRules = '';
    if (ev === 'SessionStart') {
      try { voiceRules = fs.readFileSync(path.join(cfg.root, 'layers', 'eap-voice', 'EAP-VOICE.md'), 'utf8').trim(); } catch { /* optional */ }
    }
    if (ev === 'SessionStart' || ev === 'PostToolUse' || ev === 'PreCompact') runtime = await buildRuntime(cfg);

    const result = await dispatch(ev, input, {
      voiceRules,
      runtime,
      contextAvailable: !!cfg.context,
      now: () => Date.now(),
    });

    if (result && typeof result.additionalContext === 'string' && result.additionalContext) {
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
