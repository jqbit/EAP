// EAP-Runtime — deterministic context-offload store (clean-room).
//
// Implements the offload primitive from layers/eap-runtime/DESIGN.md: index an
// oversized blob into a local full-text store behind a searchable pointer, then
// return exact matching chunks (lossless) on query. No LLM, no network, no
// third-party runtime dependency — built on Node's built-in `node:sqlite`.
//
// Retrieval fuses two lexical views of the same chunks:
//   • a porter/unicode61 table — stemmed word matching (good for natural text);
//   • a trigram table          — substring matching (good for ids, paths, code).
// Their ranked hit lists are merged with Reciprocal Rank Fusion (RRF), then
// nudged by title/source weighting. Returns stay LOSSLESS — the exact chunk body
// is always included; FTS5 snippet() is added only as an extra locator field.
//
// This is original clean-room code; no Elastic-Licensed upstream source was
// used. See docs/legal/ATTRIBUTION.md.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Default size threshold (bytes) above which content is offloaded rather than
// returned inline. Matches DESIGN.md (~100 KB).
export const OFFLOAD_THRESHOLD_BYTES = 100 * 1024;

// RRF constant. 60 is the value from the original Cormack et al. paper; it damps
// the influence of any single ranker so the fusion is stable.
export const RRF_K = 60;

// A small, deterministic English stopword set. Used only to drop noise terms
// from the *keyword* side of a query (the substring/trigram side is unaffected)
// and to build clean vocabularies. Kept tiny on purpose — no linguistics.
export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'were', 'will', 'with', 'we', 'you', 'your', 'they', 'their', 'not',
]);

// Tokenize into lowercase word tokens (letters/digits/underscore), Unicode-aware.
export function tokenize(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

// Split text into overlapping-free chunks on paragraph/line boundaries, capped
// at ~maxChars so FTS rows stay small and retrieval is granular.
export function chunk(text, maxChars = 2000) {
  const out = [];
  const paras = String(text).split(/\n{2,}/);
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of paras) {
    if (p.length >= maxChars) {
      flush();
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + p.length + 2 > maxChars) flush();
    buf += (buf ? '\n\n' : '') + p;
  }
  flush();
  return out;
}

// Build an FTS5 phrase literal from a raw token (quotes escaped) so punctuation
// and operators are treated as data, not syntax.
const phrase = (t) => '"' + String(t).replace(/"/g, '""') + '"';

// Probe node:sqlite feature availability (for eap_doctor): can we open a db and
// create both FTS5 tokenizers? Never throws — returns a plain report.
export function probeSqlite() {
  const report = { ok: false, fts5: false, trigram: false, error: null };
  try {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE p USING fts5(body, tokenize='porter unicode61')");
      report.fts5 = true;
      db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')");
      report.trigram = true;
      report.ok = true;
    } finally { db.close(); }
  } catch (e) {
    report.error = e.message;
  }
  return report;
}

export class RuntimeStore {
  // dbPath: ':memory:' for tests, or an absolute path under .eap/ in production.
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        doc_id UNINDEXED, idx UNINDEXED, body,
        tokenize = 'porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5(
        doc_id UNINDEXED, idx UNINDEXED, body,
        tokenize = 'trigram'
      );
    `);
  }

  // Deterministic id from the source label + content hash (no clock, no random),
  // so re-indexing identical content is idempotent and reproducible.
  _id(source, content) {
    return 'eap_' + createHash('sha256')
      .update(source + '\0' + content).digest('hex').slice(0, 16);
  }

  // Index content and return a pointer descriptor. `createdAt` is injected (not
  // read from the clock) so callers control determinism; defaults to 0.
  index(source, content, { createdAt = 0 } = {}) {
    const body = String(content);
    const id = this._id(source, body);
    const existing = this.db.prepare('SELECT id, chunk_count, bytes FROM docs WHERE id = ?').get(id);
    if (existing) {
      return { id, source, bytes: existing.bytes, chunks: existing.chunk_count, deduped: true };
    }
    const parts = chunk(body);
    const insDoc = this.db.prepare(
      'INSERT INTO docs (id, source, bytes, chunk_count, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insChunk = this.db.prepare('INSERT INTO chunks (doc_id, idx, body) VALUES (?, ?, ?)');
    const insTri = this.db.prepare('INSERT INTO chunks_tri (doc_id, idx, body) VALUES (?, ?, ?)');
    insDoc.run(id, source, Buffer.byteLength(body), parts.length, createdAt);
    parts.forEach((p, i) => { insChunk.run(id, i, p); insTri.run(id, i, p); });
    return { id, source, bytes: Buffer.byteLength(body), chunks: parts.length, deduped: false };
  }

  // Run one FTS table's ranked query, returning [{doc_id, idx, body, snip}] best
  // first. Never throws: an FTS syntax edge case (e.g. a query too short for the
  // trigram tokenizer) just yields an empty list so the other ranker still fires.
  _rankedRows(table, matchExpr, poolLimit, docId) {
    if (!matchExpr) return [];
    const snip = table === 'chunks'
      ? `, snippet(${table}, 2, '[', ']', '…', 12) AS snip`
      : ', NULL AS snip';
    let sql = `SELECT doc_id, idx, body${snip} FROM ${table} WHERE ${table} MATCH ?`;
    const args = [matchExpr];
    if (docId) { sql += ' AND doc_id = ?'; args.push(docId); }
    sql += ' ORDER BY rank LIMIT ?'; args.push(poolLimit);
    try {
      return this.db.prepare(sql).all(...args);
    } catch {
      return [];
    }
  }

  // Lossless retrieval. Fuses the porter (keyword) and trigram (substring) views
  // of the chunk table with Reciprocal Rank Fusion, applies a small source/title
  // weight, and returns exact matching chunk bodies with their source span
  // (doc id + chunk index) — never a summary. `limit` caps returned rows.
  search(query, { limit = 5, docId = null, k = RRF_K } = {}) {
    const raw = String(query).trim();
    if (!raw) return [];
    const tokens = tokenize(raw);
    // Keyword side: significant (non-stopword) tokens AND-ed together. If the
    // query is nothing but stopwords, fall back to all tokens so it still fires.
    const significant = tokens.filter((t) => !STOPWORDS.has(t));
    const kw = (significant.length ? significant : tokens).map(phrase).join(' AND ');
    // Substring side: the whole trimmed query as one phrase. The trigram
    // tokenizer needs >= 3 chars; shorter queries lean on the keyword side only.
    const tri = raw.length >= 3 ? phrase(raw) : '';

    const pool = Math.max(limit * 4, 20);
    const porter = this._rankedRows('chunks', kw, pool, docId);
    const trigram = this._rankedRows('chunks_tri', tri, pool, docId);

    // RRF: fuse by (doc, chunk). Rank is 1-based within each list.
    const fused = new Map();
    const absorb = (rows) => rows.forEach((r, i) => {
      const key = `${r.doc_id} ${r.idx}`;
      let e = fused.get(key);
      if (!e) {
        e = { docId: r.doc_id, chunk: r.idx, body: r.body, snippet: null, score: 0 };
        fused.set(key, e);
      }
      if (r.snip != null && e.snippet == null) e.snippet = r.snip;
      e.score += 1 / (k + i + 1);
    });
    absorb(porter);
    absorb(trigram);
    if (fused.size === 0) return [];

    // Title/source weighting: chunks whose document `source` label contains a
    // significant query token get a small, bounded boost (a path/title hit is a
    // strong relevance signal). One query fetches every candidate doc's source.
    const docIds = [...new Set([...fused.values()].map((e) => e.docId))];
    if (docIds.length && significant.length) {
      const ph = docIds.map(() => '?').join(',');
      const sources = new Map(
        this.db.prepare(`SELECT id, source FROM docs WHERE id IN (${ph})`).all(...docIds)
          .map((r) => [r.id, String(r.source).toLowerCase()])
      );
      const boost = 0.5 / (k + 1);
      for (const e of fused.values()) {
        const src = sources.get(e.docId) || '';
        if (significant.some((t) => src.includes(t))) e.score += boost;
      }
    }

    // Deterministic order: score desc, then doc id, then chunk index. For rows
    // that only surfaced on the trigram side, synthesize a snippet from the head.
    return [...fused.values()]
      .sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) || a.chunk - b.chunk)
      .slice(0, limit)
      .map((e) => ({
        docId: e.docId,
        chunk: e.chunk,
        body: e.body,
        snippet: e.snippet ?? String(e.body).replace(/\s+/g, ' ').slice(0, 160),
        score: e.score,
      }));
  }

  // A short vocabulary of the most frequent significant terms across a document's
  // chunks. Deterministic (frequency desc, then alphabetical). Used to hand the
  // caller runnable eap_search terms after an intent-filtered offload.
  vocabulary(docId, { limit = 15, minLen = 3 } = {}) {
    const rows = this.db.prepare('SELECT body FROM chunks WHERE doc_id = ? ORDER BY idx').all(docId);
    const freq = new Map();
    for (const r of rows) {
      for (const t of tokenize(r.body)) {
        if (t.length < minLen || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
        freq.set(t, (freq.get(t) || 0) + 1);
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([term]) => term);
  }

  // Measured bytes-kept-out-of-context plus an *estimated* token count. Honest by
  // construction: `bytesKeptOut` is a real sum of indexed bytes (not a modeled
  // percentage, no dollar figure). `estimatedTokens` is a labelled ~bytes/4
  // heuristic — an estimate, never presented as exact. See DESIGN.md "Honesty".
  stats() {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS docs, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(chunk_count),0) AS chunks FROM docs'
    ).get();
    const bytes = Number(row.bytes);
    return {
      docs: Number(row.docs),
      bytesKeptOut: bytes,
      chunks: Number(row.chunks),
      estimatedTokens: Math.ceil(bytes / 4),
      estimateBasis: 'estimatedTokens ≈ bytesKeptOut / 4 (heuristic; not an exact tokenizer count)',
    };
  }

  // The offload decision: inline small content, index+pointer for large content.
  // Returns either {inline:true, body} or {inline:false, pointer, hint}.
  offload(source, content, { threshold = OFFLOAD_THRESHOLD_BYTES, createdAt = 0 } = {}) {
    const bytes = Buffer.byteLength(String(content));
    if (bytes <= threshold) return { inline: true, body: String(content), bytes };
    const p = this.index(source, content, { createdAt });
    return {
      inline: false,
      pointer: p.id,
      bytes,
      hint: `Indexed ${p.chunks} section(s) from ${source} (${bytes} bytes kept out of context). ` +
            `Query with eap_search(query, { docId: "${p.id}" }).`,
    };
  }

  // Store health for eap_doctor: integrity check + measured stats. Never throws.
  health() {
    let integrity = 'unknown';
    try { integrity = this.db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown'; }
    catch (e) { integrity = `error: ${e.message}`; }
    return { ok: integrity === 'ok', integrity, ...this.stats() };
  }

  // Maintenance: drop one document (docId) or clear the whole store. Returns the
  // number of documents removed. Used by eap_purge.
  purge({ docId = null } = {}) {
    if (docId) {
      const existed = this.db.prepare('SELECT 1 FROM docs WHERE id = ?').get(docId) ? 1 : 0;
      this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM chunks_tri WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
      return { removedDocs: existed, docId };
    }
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
    this.db.exec('DELETE FROM chunks; DELETE FROM chunks_tri; DELETE FROM docs;');
    return { removedDocs: Number(before), docId: null };
  }

  close() { this.db.close(); }
}
