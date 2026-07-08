// EAP-Runtime — session continuity (clean-room, spec-only implementation).
//
// Implements move 3 of layers/eap-runtime/DESIGN.md: tool calls, edits, reads,
// decisions, tasks, and errors are logged as events to the per-project store;
// before compaction a small priority-tiered snapshot (<= ~2KB) is written; at
// the next SessionStart restore() rehydrates it so working state survives
// compaction and --continue.
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
  ['cwd', 'env', 'skill', 'subagent'],                          // 3: ambient context
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

// Render one event line. Error events are tagged with their classification so a
// snapshot reader can scan failure modes: `[error:timeout] ...`.
function eventLine(e) {
  const label = e.kind === 'error' ? `error:${classifyError(e.summary)}` : e.kind;
  return `\n[${label}] ${oneLine(e.summary)} @${e.ts}`;
}

// Pure snapshot builder: events -> compact text, hard-capped at maxBytes.
// Ordering is by tier (ascending), then recency (newest first), then insertion
// order — fully deterministic for a given event list and injected ts. Each tier
// that keeps at least one event is preceded by a runnable retrieval hint; hints
// and events share the byte budget, and a hint is only emitted immediately
// before an event that fits (so no orphan headers).
export function buildSnapshot(events, { ts = 0, maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
  const header = `EAP session snapshot @${ts} — ${events.length} event(s)`;
  const ordered = events
    .map((e, i) => ({ ...e, _i: i }))
    .sort((a, b) =>
      tierOf(a.kind) - tierOf(b.kind) || b.ts - a.ts || b._i - a._i);

  const parts = [header];
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
      if (hintText) { parts.push(hintText); size += hb; lastTier = tier; }
      parts.push(line);
      size += b;
    } else {
      omitted++;
    }
  }
  if (omitted > 0) {
    // The elision marker must itself fit inside the cap; drop trailing lines
    // (lowest-priority of what made it in) until it does.
    let marker = `\n(+${omitted} more event(s) in the store)`;
    while (parts.length > 1 && size + Buffer.byteLength(marker) > maxBytes) {
      size -= Buffer.byteLength(parts.pop());
      omitted++;
      marker = `\n(+${omitted} more event(s) in the store)`;
    }
    if (size + Buffer.byteLength(marker) <= maxBytes) parts.push(marker);
  }
  return parts.join('');
}

// Note text surfacing project memory files as retrievable pointers (no content).
function memoryNote(mem) {
  const list = mem.map((m) => `${m.name} (present at project root — read on demand, not injected)`).join('; ');
  return `# project memory — ${list}`;
}

// Event log + snapshot persistence on the store's existing SQLite database
// (DESIGN.md "Storage": one database, chunks FTS + session event log/snapshots).
export class SessionLog {
  // Accepts a RuntimeStore (reuses its db) or a raw DatabaseSync handle.
  constructor(storeOrDb) {
    this.db = storeOrDb?.db ?? storeOrDb;
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

  // Append one event. ts is required and injected (no Date.now here). `kind` may
  // be any string; the taxonomy in EVENT_KINDS drives priority but is not a
  // hard whitelist (unknown kinds fall to the lowest tier).
  append({ ts, kind, summary } = {}) {
    if (!Number.isFinite(ts)) throw new TypeError('append: ts must be a finite number (inject it; this module never reads the clock)');
    if (typeof kind !== 'string' || !kind.trim()) throw new TypeError('append: kind must be a non-empty string');
    if (typeof summary !== 'string' || !summary.trim()) throw new TypeError('append: summary must be a non-empty string');
    const r = this.db.prepare('INSERT INTO events (ts, kind, summary) VALUES (?, ?, ?)')
      .run(Math.trunc(ts), kind.trim(), summary);
    return { seq: Number(r.lastInsertRowid) };
  }

  events() {
    return this.db.prepare('SELECT seq, ts, kind, summary FROM events ORDER BY seq').all()
      .map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), kind: r.kind, summary: r.summary }));
  }

  // Build the priority-tiered snapshot, persist it (single latest row), and
  // return it. Called at PreCompact.
  snapshot({ ts = 0, maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
    const evs = this.events();
    const body = buildSnapshot(evs, { ts, maxBytes });
    this.db.prepare('INSERT OR REPLACE INTO snapshots (id, ts, body) VALUES (1, ?, ?)')
      .run(Math.trunc(ts), body);
    return { ts: Math.trunc(ts), body, bytes: Buffer.byteLength(body), events: evs.length };
  }

  // Return the latest persisted snapshot (or null). Called at SessionStart.
  //
  // `memoryFiles` (optional, injected — this module never touches the filesystem)
  // is a list of project memory file names present at the root, e.g.
  // ['CLAUDE.md','AGENTS.md']. When provided, their presence is surfaced as
  // retrievable pointers (a note appended to the body + a `memory` field); their
  // CONTENT is never read or injected. With no memoryFiles the return is byte-for-
  // byte identical to the persisted snapshot (backward-compatible).
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
