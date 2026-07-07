// EAP-Runtime — session continuity (clean-room, spec-only implementation).
//
// Implements move 3 of layers/eap-runtime/DESIGN.md: tool calls, edits, and
// decisions are logged as events to the per-project store; before compaction a
// small priority-tiered snapshot (<= ~2KB) is written; at the next SessionStart
// restore() rehydrates it so working state survives compaction and --continue.
//
// Deterministic by construction: every timestamp is injected by the caller —
// there is no clock read anywhere in this module.

export const SNAPSHOT_MAX_BYTES = 2048;
export const SUMMARY_MAX_CHARS = 240;

// Priority tiers for snapshot inclusion. Lower tier = kept first when the byte
// budget bites. Decisions and errors are the working state an agent most needs
// back after compaction; tool chatter is the most disposable.
const TIERS = [
  ['decision', 'error'], // tier 0: conclusions and failures
  ['edit', 'write'],     // tier 1: what was changed on disk
  ['tool', 'exec'],      // tier 2: what was run
];

export function tierOf(kind) {
  const i = TIERS.findIndex((t) => t.includes(kind));
  return i === -1 ? TIERS.length : i; // unknown kinds: below all named tiers
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);

// Pure snapshot builder: events -> compact text, hard-capped at maxBytes.
// Ordering is by tier (ascending), then recency (newest first), then insertion
// order — fully deterministic for a given event list and injected ts.
export function buildSnapshot(events, { ts = 0, maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
  const header = `EAP session snapshot @${ts} — ${events.length} event(s)`;
  const ordered = events
    .map((e, i) => ({ ...e, _i: i }))
    .sort((a, b) =>
      tierOf(a.kind) - tierOf(b.kind) || b.ts - a.ts || b._i - a._i);

  const parts = [header];
  let size = Buffer.byteLength(header);
  let omitted = 0;
  for (const e of ordered) {
    const line = `\n[${e.kind}] ${oneLine(e.summary)} @${e.ts}`;
    const b = Buffer.byteLength(line);
    if (size + b <= maxBytes) {
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

  // Append one event. ts is required and injected (no Date.now here).
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
  restore() {
    const row = this.db.prepare('SELECT ts, body FROM snapshots WHERE id = 1').get();
    if (!row) return null;
    return { ts: Number(row.ts), body: row.body, bytes: Buffer.byteLength(row.body) };
  }
}
