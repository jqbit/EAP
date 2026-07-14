// EAP-Runtime — session continuity (clean-room, spec-only implementation).
//
// Implements move 3 of layers/eap-runtime/DESIGN.md: tool calls, edits, reads,
// decisions, tasks, and errors are logged as events to the per-project store;
// before compaction a small priority-tiered snapshot (<= ~2KB) is written; at
// the next SessionStart restore() rehydrates it so working state survives
// compaction and --continue.
//
// PostToolUse extractors (file edits, errors, git summaries, decisions) enrich
// the taxonomy from tool payloads without an LLM. PreCompact can emit a short
// Session Guide narrative that stays inside the byte budget and only cites
// measured store stats (never $/% savings claims).
//
// The snapshot stays hard-capped and deterministic, but each surviving section
// carries a runnable retrieval hint (eap_search / eap_session_restore) so the
// omitted detail is recoverable on demand rather than lost. restore() can also
// surface the presence of project memory files (CLAUDE.md / AGENTS.md) as
// retrievable pointers — it NEVER reads or injects their content.
//
// Deterministic by construction: every timestamp is injected by the caller —
// there is no clock read anywhere in this module.

export const SNAPSHOT_MAX_BYTES = 2048;
export const SUMMARY_MAX_CHARS = 240;

// Priority tiers for snapshot inclusion. Lower tier = kept first when the byte
// budget bites. Decisions/errors/rules are the working state an agent most needs
// back after compaction; ambient context (cwd/env/skill) is the most disposable.
//
// NOTE: the index positions of decision/error (0), edit (1) and tool (2) are part
// of the public contract (tierOf) — new kinds are added WITHIN these tiers or in
// the new tier 3, never by inserting a tier before `tool`.
const TIERS = [
  ['decision', 'error', 'rule'],                                 // 0: conclusions, failures, rules
  ['edit', 'write', 'file_write', 'file_edit', 'task'],          // 1: state changes + tasks
  ['tool', 'exec', 'file_read', 'git', 'intent'],               // 2: actions, reads, retrieval
  ['cwd', 'env', 'skill', 'subagent', 'turn'],                  // 3: ambient context (turn = Stop-hook turn boundary)
];

// A short runnable retrieval hint per tier, emitted once before that tier's
// first surviving event so the elided detail stays recoverable.
const TIER_HINTS = [
  '# decisions/errors/rules — full log via eap_session_restore()',
  '# changes/tasks — re-read a path via eap_search(query, { docId })',
  '# actions/reads — recover offloaded output via eap_search(query, { docId })',
  '# context — ambient; eap_session_restore() for the rest',
];

export function tierOf(kind) {
  const i = TIERS.findIndex((t) => t.includes(kind));
  return i === -1 ? TIERS.length : i; // unknown kinds: below all named tiers
}

// The full event taxonomy this module recognises (for validation/introspection).
export const EVENT_KINDS = [...new Set(TIERS.flat())];

// Coarse error classification from an error summary — a deterministic keyword
// map, no LLM. Used to tag error lines in the snapshot so failure modes are
// scannable. Returns one of a small fixed vocabulary.
export function classifyError(summary) {
  const s = String(summary).toLowerCase();
  if (/\btimed?[\s-]?out\b|timeout|deadline exceeded/.test(s)) return 'timeout';
  if (/network|ssrf|dns|econn|socket|fetch|refused|unreachable/.test(s)) return 'network';
  if (/permission|eacces|denied|forbidden|unauthor/.test(s)) return 'permission';
  if (/not[\s-]?found|enoent|no such|missing|404/.test(s)) return 'not-found';
  if (/syntax|parse|unexpected token|invalid/.test(s)) return 'syntax';
  if (/runtime[\s-]?not[\s-]?available|not installed|spawn|enoexec/.test(s)) return 'runtime';
  if (/exit\s*(code)?\s*[1-9]|non-?zero|failed|traceback|exception/.test(s)) return 'runtime-error';
  return 'other';
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);

// ── PostToolUse extractors (deterministic, no LLM) ───────────────────────────

const EDIT_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'StrReplace', 'CreateFile',
  'Delete', 'DeleteFile', 'ApplyPatch',
]);

function toolName(input) {
  return input && typeof input === 'object' && typeof input.tool_name === 'string'
    ? input.tool_name : '';
}

function toolInput(input) {
  const ti = input && typeof input === 'object' ? input.tool_input : null;
  return ti && typeof ti === 'object' ? ti : {};
}

function toolOutputText(input) {
  if (!input || typeof input !== 'object') return '';
  const r = input.tool_response ?? input.tool_output ?? input.output ?? input.stdout;
  if (r == null) return '';
  return typeof r === 'string' ? r : JSON.stringify(r);
}

/** Paths touched by edit/write tools. */
export function extractEditedFiles(input) {
  const tool = toolName(input);
  const ti = toolInput(input);
  const paths = [];
  const push = (p) => {
    if (typeof p === 'string' && p.trim()) paths.push(p.trim());
  };
  if (EDIT_TOOLS.has(tool) || /edit|write|create|delete|patch/i.test(tool)) {
    push(ti.file_path || ti.path || ti.target || ti.notebook_path);
    if (Array.isArray(ti.edits)) {
      for (const e of ti.edits) {
        if (e && typeof e === 'object') push(e.file_path || e.path);
      }
    }
  }
  return [...new Set(paths)];
}

/** Error-like signals from tool output / is_error flags. */
export function extractErrors(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  if (input.is_error === true || input.isError === true) {
    out.push(oneLine(toolOutputText(input) || 'tool reported is_error'));
  }
  const text = toolOutputText(input);
  if (!text) return out;
  const lines = text.split('\n');
  for (const line of lines.slice(0, 40)) {
    if (/\b(error|exception|traceback|fatal|failed)\b/i.test(line)
      && !/0 error/i.test(line)) {
      out.push(oneLine(line));
      if (out.length >= 3) break;
    }
  }
  // Exit-code failures from Bash-like tools.
  if (typeof input.exit_code === 'number' && input.exit_code !== 0) {
    out.push(oneLine(`exit ${input.exit_code}: ${text.slice(0, 120)}`));
  }
  return [...new Set(out)];
}

/** Short git status / log summary from Bash git commands. */
export function extractGitSummary(input) {
  const tool = toolName(input);
  const ti = toolInput(input);
  const cmd = typeof ti.command === 'string' ? ti.command : '';
  if (tool !== 'Bash' && tool !== 'Shell') return null;
  if (!/\bgit\b/.test(cmd)) return null;
  const text = toolOutputText(input).trim();
  if (!text) return oneLine(`git: ${cmd.slice(0, 80)}`);
  // Prefer a compact head of status/log output.
  const head = text.split('\n').filter((l) => l.trim()).slice(0, 6).join(' | ');
  return oneLine(`git ${cmd.replace(/^git\s+/, '').slice(0, 40)}: ${head}`);
}

/** Heuristic decision phrases in tool output or explicit Decision markers. */
export function extractDecisions(input) {
  const text = toolOutputText(input);
  if (!text) return [];
  const found = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:decision|decided|chose|we(?:'| a)?re going with)\s*[:—-]\s*(.+)$/i)
      || line.match(/^\s*DECISION\s*[:—-]\s*(.+)$/i);
    if (m) {
      found.push(oneLine(m[1] || m[0]));
      if (found.length >= 2) break;
    }
  }
  return found;
}

/**
 * Expand a PostToolUse (or similar) payload into taxonomy events.
 * Returns [{ kind, summary }, ...] — caller injects `ts` when appending.
 */
export function extractSessionEvents(input) {
  const events = [];
  for (const p of extractEditedFiles(input)) {
    events.push({ kind: 'file_edit', summary: `edited ${p}` });
  }
  for (const err of extractErrors(input)) {
    events.push({ kind: 'error', summary: err });
  }
  const git = extractGitSummary(input);
  if (git) events.push({ kind: 'git', summary: git });
  for (const d of extractDecisions(input)) {
    events.push({ kind: 'decision', summary: d });
  }
  return events;
}

/**
 * Short Session Guide narrative for PreCompact / resume. Measured honesty only:
 * cites event counts and optional store bytes — never $/% savings claims.
 * Hard-capped so it can sit beside (or inside) the tiered snapshot budget.
 */
export function buildSessionGuide(events, {
  maxBytes = 600,
  stats = null,
} = {}) {
  const list = Array.isArray(events) ? events : [];
  const count = (kind) => list.filter((e) => e.kind === kind || (kind === 'edit' && ['edit', 'write', 'file_write', 'file_edit'].includes(e.kind))).length;
  const decisions = list.filter((e) => e.kind === 'decision').slice(-3);
  const errors = list.filter((e) => e.kind === 'error').slice(-3);
  const edits = list.filter((e) => ['edit', 'write', 'file_write', 'file_edit'].includes(e.kind)).slice(-5);
  const git = list.filter((e) => e.kind === 'git').slice(-2);

  const lines = ['## EAP Session Guide'];
  lines.push(`Events: ${list.length} (decisions ${count('decision')}, errors ${count('error')}, edits ${count('edit')}, git ${count('git')}).`);
  if (stats && Number.isFinite(stats.bytesKeptOut)) {
    lines.push(`Store (measured): ${stats.docs ?? '?'} docs, ${stats.bytesKeptOut} bytes kept out of context`
      + (stats.chunks != null ? `, ${stats.chunks} chunks` : '') + '.');
  }
  if (decisions.length) {
    lines.push('Decisions:');
    for (const d of decisions) lines.push(`- ${oneLine(d.summary)}`);
  }
  if (errors.length) {
    lines.push('Errors:');
    for (const e of errors) lines.push(`- [${classifyError(e.summary)}] ${oneLine(e.summary)}`);
  }
  if (edits.length) {
    lines.push('Files touched:');
    for (const e of edits) lines.push(`- ${oneLine(e.summary)}`);
  }
  if (git.length) {
    lines.push('Git:');
    for (const g of git) lines.push(`- ${oneLine(g.summary)}`);
  }
  lines.push('Recover detail via eap_session_restore() / eap_search(query).');

  let body = lines.join('\n');
  while (Buffer.byteLength(body) > maxBytes && lines.length > 3) {
    lines.splice(2, 1); // drop from the middle/top detail first after header+counts
    body = lines.join('\n');
  }
  if (Buffer.byteLength(body) > maxBytes) {
    body = body.slice(0, maxBytes);
  }
  return body;
}

// Render one event line. Error events are tagged with their classification so a
// snapshot reader can scan failure modes: `[error:timeout] ...`.
function eventLine(e) {
  const label = e.kind === 'error' ? `error:${classifyError(e.summary)}` : e.kind;
  return `\n[${label}] ${oneLine(e.summary)} @${e.ts}`;
}

// Pure snapshot builder: events -> compact text, hard-capped at maxBytes.
// Priority events pack first; an optional Session Guide fills leftover budget
// (inserted after the header) so tiny caps never drop decisions for prose.
export function buildSnapshot(events, { ts = 0, maxBytes = SNAPSHOT_MAX_BYTES, guide = null } = {}) {
  const header = `EAP session snapshot @${ts} — ${events.length} event(s)`;
  const ordered = events
    .map((e, i) => ({ ...e, _i: i }))
    .sort((a, b) =>
      tierOf(a.kind) - tierOf(b.kind) || b.ts - a.ts || b._i - a._i);

  const eventParts = [];
  let size = Buffer.byteLength(header);
  let omitted = 0;
  let lastTier = null;
  for (const e of ordered) {
    const line = eventLine(e);
    const b = Buffer.byteLength(line);
    const tier = tierOf(e.kind);
    const hintText = tier !== lastTier ? `\n${TIER_HINTS[tier] ?? '# other'}` : '';
    const hb = Buffer.byteLength(hintText);
    if (size + hb + b <= maxBytes) {
      if (hintText) { eventParts.push(hintText); size += hb; lastTier = tier; }
      eventParts.push(line);
      size += b;
    } else {
      omitted++;
    }
  }
  if (omitted > 0) {
    let marker = `\n(+${omitted} more event(s) in the store)`;
    while (eventParts.length > 0 && size + Buffer.byteLength(marker) > maxBytes) {
      size -= Buffer.byteLength(eventParts.pop());
      omitted++;
      marker = `\n(+${omitted} more event(s) in the store)`;
    }
    if (size + Buffer.byteLength(marker) <= maxBytes) {
      eventParts.push(marker);
      size += Buffer.byteLength(marker);
    }
  }

  const parts = [header];
  if (guide && typeof guide === 'string' && guide.trim()) {
    let g = '\n' + guide.trim();
    const room = maxBytes - size;
    if (room > 40) {
      while (Buffer.byteLength(g) > room) g = g.slice(0, Math.max(0, g.length - 8));
      if (g.trim().length > 20) {
        parts.push(g);
        size += Buffer.byteLength(g);
      }
    }
  }
  parts.push(...eventParts);
  return parts.join('');
}

function memoryNote(mem) {
  const list = mem.map((m) => `${m.name} (present at project root — read on demand, not injected)`).join('; ');
  return `# project memory — ${list}`;
}

// Event log + snapshot persistence on the store's existing SQLite database.
export class SessionLog {
  constructor(storeOrDb) {
    this.db = storeOrDb?.db ?? storeOrDb;
    this.store = storeOrDb?.stats ? storeOrDb : null;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ts INTEGER NOT NULL,
        body TEXT NOT NULL
      );
    `);
  }

  append({ ts, kind, summary } = {}) {
    if (!Number.isFinite(ts)) throw new TypeError('append: ts must be a finite number (inject it; this module never reads the clock)');
    if (typeof kind !== 'string' || !kind.trim()) throw new TypeError('append: kind must be a non-empty string');
    if (typeof summary !== 'string' || !summary.trim()) throw new TypeError('append: summary must be a non-empty string');
    const r = this.db.prepare('INSERT INTO events (ts, kind, summary) VALUES (?, ?, ?)')
      .run(Math.trunc(ts), kind.trim(), summary);
    return { seq: Number(r.lastInsertRowid) };
  }

  /** Append extractor events from a tool payload. */
  appendFromTool(input, { ts } = {}) {
    if (!Number.isFinite(ts)) throw new TypeError('appendFromTool: ts required');
    const added = [];
    for (const ev of extractSessionEvents(input)) {
      added.push(this.append({ ts, kind: ev.kind, summary: ev.summary }));
    }
    return { added: added.length, seqs: added.map((a) => a.seq) };
  }

  events() {
    return this.db.prepare('SELECT seq, ts, kind, summary FROM events ORDER BY seq').all()
      .map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), kind: r.kind, summary: r.summary }));
  }

  // Build the priority-tiered snapshot (+ optional Session Guide), persist it.
  snapshot({ ts = 0, maxBytes = SNAPSHOT_MAX_BYTES, includeGuide = true } = {}) {
    const evs = this.events();
    let guide = null;
    if (includeGuide) {
      const stats = this.store && typeof this.store.stats === 'function' ? this.store.stats() : null;
      const guideBudget = Math.min(600, Math.floor(maxBytes * 0.35));
      guide = buildSessionGuide(evs, { maxBytes: guideBudget, stats });
    }
    const body = buildSnapshot(evs, { ts, maxBytes, guide });
    this.db.prepare('INSERT OR REPLACE INTO snapshots (id, ts, body) VALUES (1, ?, ?)')
      .run(Math.trunc(ts), body);
    return { ts: Math.trunc(ts), body, bytes: Buffer.byteLength(body), events: evs.length, guide: !!guide };
  }

  restore({ memoryFiles = [] } = {}) {
    const row = this.db.prepare('SELECT ts, body FROM snapshots WHERE id = 1').get();
    const mem = (Array.isArray(memoryFiles) ? memoryFiles : [])
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => ({ name: n.trim(), retrieve: `read/eap_search on demand — ${n.trim()} not injected` }));

    if (!row) {
      if (mem.length === 0) return null;
      const body = memoryNote(mem);
      return { ts: null, body, bytes: Buffer.byteLength(body), memory: mem };
    }
    let body = row.body;
    if (mem.length) body += '\n' + memoryNote(mem);
    const out = { ts: Number(row.ts), body, bytes: Buffer.byteLength(body) };
    if (mem.length) out.memory = mem;
    return out;
  }
}
