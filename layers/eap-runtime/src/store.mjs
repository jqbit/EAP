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
// nudged by title/source weighting, optional proximity rerank, content_kind
// filter, multi-query fusion, and a small edit-distance fuzzy corrector for
// zero-hit queries. Returns stay LOSSLESS — the exact chunk body is always
// included; FTS5 snippet() is an extra locator field only.
//
// Indexed path docs carry a content_hash so search can flag stale hits when the
// on-disk file has changed. Fetch-indexed docs may carry expires_at (TTL) and
// are removed by purgeExpired().
//
// This is original clean-room code; no Elastic-Licensed upstream source was
// used. See docs/legal/ATTRIBUTION.md.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// Default size threshold (bytes) above which content is offloaded rather than
// returned inline. Matches DESIGN.md (~100 KB).
export const OFFLOAD_THRESHOLD_BYTES = 100 * 1024;

// Default TTL for fetch-indexed content (24h). Overridable per call / env.
export const DEFAULT_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

// RRF constant. 60 is the value from the original Cormack et al. paper; it damps
// the influence of any single ranker so the fusion is stable.
export const RRF_K = 60;

// Progressive search throttle (optional). Off unless EAP_SEARCH_THROTTLE=1 or
// callers pass { throttle: true | ms }. Caps successive search call latency.
export const SEARCH_THROTTLE_BASE_MS = 25;
export const SEARCH_THROTTLE_MAX_MS = 250;

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

// Content-kind classifier for filter + reporting. Heuristic, deterministic.
export function classifyContentKind(text) {
  const s = String(text);
  const fence = (s.match(/```/g) || []).length >= 2;
  const codeHits = (s.match(
    /\b(function|const|let|var|import|export|class|def|fn|package|SELECT|INSERT)\b|[{};]\s*$/gm
  ) || []).length;
  const proseHits = (s.match(/^#{1,6}\s+\S+/gm) || []).length
    + (s.match(/\b(the|and|with|from|that|this)\b/gi) || []).length;
  const codeScore = (fence ? 8 : 0) + Math.min(codeHits, 20);
  const proseScore = Math.min(proseHits, 30);
  if (codeScore >= 6 && proseScore >= 8) return 'mixed';
  if (codeScore >= 6) return 'code';
  return 'prose';
}

// Markdown heuristic: ATX headings, fenced blocks, or link/image syntax.
export function looksLikeMarkdown(text) {
  const s = String(text);
  if (/^#{1,6}\s+\S/m.test(s)) return true;
  if (/```/.test(s)) return true;
  if (/^\s*[-*+]\s+\S/m.test(s) && /\[.+\]\(.+\)/.test(s)) return true;
  return false;
}

// Hash bytes of content (hex sha256). Used for stale-file detection.
export function contentHash(content) {
  return createHash('sha256').update(String(content)).digest('hex');
}

// Classic Levenshtein (stdlib only). Small strings only — query tokens / vocab.
export function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const m = s.length;
  const n = t.length;
  // eap-lean: O(nm) DP — upgrade path: banded/automata if vocab>>10k
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Split preserving fenced code blocks as atomic segments. Non-fence text is
// returned as separate segments in order.
function splitFences(text) {
  const s = String(text);
  const parts = [];
  const re = /```[^\n]*\n[\s\S]*?```/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', body: s.slice(last, m.index) });
    parts.push({ kind: 'fence', body: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ kind: 'text', body: s.slice(last) });
  return parts.length ? parts : [{ kind: 'text', body: s }];
}

// Split markdown prose on ATX headings, keeping the heading with its section.
function splitHeadings(text) {
  const s = String(text);
  const lines = s.split('\n');
  const sections = [];
  let buf = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push(body);
    buf = [];
  };
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line) && buf.length) flush();
    buf.push(line);
  }
  flush();
  return sections.length ? sections : [s];
}

// Pack strings into <= maxChars chunks without splitting fenced blocks when
// those blocks fit; oversized fences are hard-sliced as a last resort.
function packParts(parts, maxChars) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const part of parts) {
    if (part.length >= maxChars) {
      flush();
      for (let i = 0; i < part.length; i += maxChars) out.push(part.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + part.length + 2 > maxChars) flush();
    buf += (buf ? '\n\n' : '') + part;
  }
  flush();
  return out;
}

// Plain paragraph chunker (non-markdown path).
function chunkParagraphs(text, maxChars) {
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

// Split text into chunks. When content looks like markdown (or `{ markdown:true }`
// is passed), preserve fenced code blocks and prefer heading boundaries so a
// heading section stays together under the cap.
export function chunk(text, maxChars = 2000, opts = {}) {
  const s = String(text);
  const asMd = opts.markdown === true || (opts.markdown !== false && looksLikeMarkdown(s));
  if (!asMd) return chunkParagraphs(s, maxChars);

  const units = [];
  for (const seg of splitFences(s)) {
    if (seg.kind === 'fence') {
      units.push(seg.body.trim());
      continue;
    }
    for (const section of splitHeadings(seg.body)) {
      if (!section.trim()) continue;
      // Within a section, still pack by paragraphs under the cap.
      for (const p of chunkParagraphs(section, maxChars)) units.push(p);
    }
  }
  // Re-pack units that are small so we do not over-fragment tiny headings;
  // never merge across a fence that already equals/exceeds the cap.
  return packParts(units, maxChars);
}

// Build an FTS5 phrase literal from a raw token (quotes escaped) so punctuation
// and operators are treated as data, not syntax.
const phrase = (t) => '"' + String(t).replace(/"/g, '""') + '"';

// Min window (chars) covering all significant tokens in body, or Infinity.
export function proximityWindow(body, terms) {
  const lower = String(body).toLowerCase();
  const positions = [];
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx < 0) return Number.POSITIVE_INFINITY;
    positions.push({ t, idx, end: idx + t.length });
  }
  // Expand: find earliest start / latest end among first occurrences.
  // eap-lean: first-occurrence window — upgrade path: true multi-occurrence min window
  const start = Math.min(...positions.map((p) => p.idx));
  const end = Math.max(...positions.map((p) => p.end));
  return end - start;
}

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

function migrateDocsSchema(db) {
  let cols;
  try {
    cols = new Set(db.prepare('PRAGMA table_info(docs)').all().map((r) => r.name));
  } catch { return; }
  const add = (name, decl) => {
    if (!cols.has(name)) {
      try { db.exec(`ALTER TABLE docs ADD COLUMN ${name} ${decl}`); } catch { /* raced */ }
    }
  };
  add('content_hash', 'TEXT');
  add('path', 'TEXT');
  add('expires_at', 'INTEGER');
  add('content_kind', 'TEXT');
}

// Open (or create) the on-disk store under multi-agent contention.
// WAL + busy_timeout handle steady-state sharing; a short open retry covers the
// cold-start CREATE race when many CLIs hit a brand-new runtime.db together.
// eap-lean: fixed 8 attempts / 5s busy — upgrade path: longer if lock storms rise
function openRuntimeDb(dbPath) {
  const schema = `
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        content_hash TEXT,
        path TEXT,
        expires_at INTEGER,
        content_kind TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        doc_id UNINDEXED, idx UNINDEXED, body,
        tokenize = 'porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5(
        doc_id UNINDEXED, idx UNINDEXED, body,
        tokenize = 'trigram'
      );
    `;
  const attempts = dbPath === ':memory:' ? 1 : 8;
  let last;
  for (let i = 0; i < attempts; i++) {
    let db;
    try {
      db = new DatabaseSync(dbPath);
      if (dbPath !== ':memory:') {
        db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      }
      db.exec(schema);
      migrateDocsSchema(db);
      return db;
    } catch (err) {
      last = err;
      try { db?.close(); } catch { /* ignore close races */ }
      const msg = String(err?.message || err);
      const busy = /database is locked|SQLITE_BUSY|errcode:\s*5/i.test(msg);
      if (!busy || i === attempts - 1) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
  throw last;
}

// Module-level progressive throttle counter (optional; reset via resetSearchThrottle).
let _searchCalls = 0;
export function resetSearchThrottle() { _searchCalls = 0; }

function applyThrottle(throttle) {
  let ms = 0;
  if (throttle === true || throttle === 'progressive') {
    _searchCalls += 1;
    ms = Math.min(SEARCH_THROTTLE_MAX_MS, SEARCH_THROTTLE_BASE_MS * _searchCalls);
  } else if (Number.isFinite(throttle) && throttle > 0) {
    ms = Math.min(SEARCH_THROTTLE_MAX_MS, Math.floor(throttle));
  } else if (process.env.EAP_SEARCH_THROTTLE === '1') {
    _searchCalls += 1;
    ms = Math.min(SEARCH_THROTTLE_MAX_MS, SEARCH_THROTTLE_BASE_MS * _searchCalls);
  }
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  return ms;
}

function chunkMatchesKind(body, contentType) {
  if (!contentType || contentType === 'all') return true;
  const kind = classifyContentKind(body);
  if (contentType === 'code') return kind === 'code' || kind === 'mixed';
  if (contentType === 'prose') return kind === 'prose' || kind === 'mixed';
  return true;
}

export class RuntimeStore {
  // dbPath: ':memory:' for tests, or an absolute path under .eap/ in production.
  constructor(dbPath = ':memory:') {
    this.db = openRuntimeDb(dbPath);
  }

  // Deterministic id from the source label + content hash (no clock, no random),
  // so re-indexing identical content is idempotent and reproducible.
  _id(source, content) {
    return 'eap_' + createHash('sha256')
      .update(source + '\0' + content).digest('hex').slice(0, 16);
  }

  // Index content and return a pointer descriptor. `createdAt` is injected (not
  // read from the clock) so callers control determinism; defaults to 0.
  // Optional: path + contentHash for stale detection; expiresAt / ttlMs for TTL;
  // contentKind override; markdown force for chunker.
  index(source, content, {
    createdAt = 0,
    path = null,
    contentHash: hashOpt = null,
    expiresAt = null,
    ttlMs = null,
    contentKind = null,
    markdown = undefined,
    now = null,
  } = {}) {
    const body = String(content);
    const id = this._id(source, body);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT id, chunk_count, bytes FROM docs WHERE id = ?').get(id);
      if (existing) {
        this.db.exec('COMMIT');
        return { id, source, bytes: existing.bytes, chunks: existing.chunk_count, deduped: true };
      }
      const parts = chunk(body, 2000, { markdown });
      const bytes = Buffer.byteLength(body);
      const hash = hashOpt || contentHash(body);
      const kind = contentKind || classifyContentKind(body);
      let exp = expiresAt;
      if (exp == null && Number.isFinite(ttlMs) && ttlMs > 0) {
        const base = Number.isFinite(now) ? now : createdAt;
        exp = base + Math.floor(ttlMs);
      }
      if (ttlMs === 0) exp = null; // ttl:0 means no expiry
      const insDoc = this.db.prepare(
        `INSERT INTO docs (id, source, bytes, chunk_count, created_at, content_hash, path, expires_at, content_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insChunk = this.db.prepare('INSERT INTO chunks (doc_id, idx, body) VALUES (?, ?, ?)');
      const insTri = this.db.prepare('INSERT INTO chunks_tri (doc_id, idx, body) VALUES (?, ?, ?)');
      insDoc.run(id, source, bytes, parts.length, createdAt, hash, path, exp, kind);
      parts.forEach((p, i) => { insChunk.run(id, i, p); insTri.run(id, i, p); });
      this.db.exec('COMMIT');
      return {
        id, source, bytes, chunks: parts.length, deduped: false,
        contentHash: hash, path: path || null, expiresAt: exp, contentKind: kind,
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  // Run one FTS table's ranked query, returning [{doc_id, idx, body, snip}] best
  // first. Never throws: an FTS syntax edge case just yields an empty list.
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

  // Annotate hits with stale:true when path content_hash no longer matches disk.
  _annotateStale(hits, { checkStale = true, readFile = readFileSync, exists = existsSync } = {}) {
    if (!checkStale || !hits.length) return hits;
    const docIds = [...new Set(hits.map((h) => h.docId))];
    const ph = docIds.map(() => '?').join(',');
    const meta = new Map(
      this.db.prepare(
        `SELECT id, path, content_hash FROM docs WHERE id IN (${ph})`
      ).all(...docIds).map((r) => [r.id, r])
    );
    return hits.map((h) => {
      const m = meta.get(h.docId);
      if (!m || !m.path || !m.content_hash) return { ...h, stale: false };
      try {
        if (!exists(m.path)) return { ...h, stale: true, staleReason: 'missing' };
        const cur = contentHash(readFile(m.path, 'utf8'));
        if (cur !== m.content_hash) return { ...h, stale: true, staleReason: 'changed' };
        return { ...h, stale: false };
      } catch {
        return { ...h, stale: true, staleReason: 'unreadable' };
      }
    });
  }

  // Fuzzy-correct tokens against store vocabulary when a query yields zero hits.
  // Returns corrected query string or null if no useful correction.
  _fuzzyCorrect(query, { maxDist = 2, docId = null } = {}) {
    const tokens = tokenize(query).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    if (!tokens.length) return null;
    let vocabSql = 'SELECT body FROM chunks';
    const args = [];
    if (docId) { vocabSql += ' WHERE doc_id = ?'; args.push(docId); }
    vocabSql += ' LIMIT 400';
    const rows = this.db.prepare(vocabSql).all(...args);
    const vocab = new Set();
    for (const r of rows) {
      for (const t of tokenize(r.body)) {
        if (t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t)) vocab.add(t);
      }
    }
    if (!vocab.size) return null;
    const corrected = tokens.map((tok) => {
      if (vocab.has(tok)) return tok;
      let best = null;
      let bestD = maxDist + 1;
      for (const v of vocab) {
        if (Math.abs(v.length - tok.length) > maxDist) continue;
        const d = editDistance(tok, v);
        if (d < bestD || (d === bestD && best != null && v < best)) {
          bestD = d;
          best = v;
        }
      }
      return bestD <= maxDist && best ? best : tok;
    });
    const out = corrected.join(' ');
    return out !== tokens.join(' ') ? out : null;
  }

  // Core lossless retrieval for one query string.
  _searchOne(query, { limit = 5, docId = null, k = RRF_K, contentType = null, proximity = true } = {}) {
    const raw = String(query).trim();
    if (!raw) return [];
    const tokens = tokenize(raw);
    const significant = tokens.filter((t) => !STOPWORDS.has(t));
    const kw = (significant.length ? significant : tokens).map(phrase).join(' AND ');
    const tri = raw.length >= 3 ? phrase(raw) : '';

    const pool = Math.max(limit * 4, 20);
    const porter = this._rankedRows('chunks', kw, pool, docId);
    const trigram = this._rankedRows('chunks_tri', tri, pool, docId);

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

    // Proximity rerank: multi-term queries prefer tighter windows (stdlib).
    if (proximity && significant.length >= 2) {
      const maxBoost = 0.4 / (k + 1);
      for (const e of fused.values()) {
        const w = proximityWindow(e.body, significant);
        if (Number.isFinite(w)) {
          e.score += maxBoost * (1 / (1 + w / 80));
        }
      }
    }

    let rows = [...fused.values()];
    if (contentType && contentType !== 'all') {
      rows = rows.filter((e) => chunkMatchesKind(e.body, contentType));
    }

    return rows
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

  // Lossless retrieval. Options:
  //   limit, docId, contentType ('code'|'prose'|'all'),
  //   queries (string[]) — multi-query OR fusion in one call,
  //   fuzzy (default true) — edit-distance correction on zero hits,
  //   proximity (default true), throttle (false|true|'progressive'|ms),
  //   checkStale (default true).
  search(query, {
    limit = 5,
    docId = null,
    k = RRF_K,
    contentType = null,
    queries = null,
    fuzzy = true,
    proximity = true,
    throttle = false,
    checkStale = true,
    readFile = readFileSync,
    exists = existsSync,
  } = {}) {
    applyThrottle(throttle);

    const list = Array.isArray(queries) && queries.length
      ? queries.map(String).filter((q) => q.trim())
      : [String(query ?? '')];

    if (!list.length) return [];

    // Multi-query: fuse per-query RRF lists with another RRF pass.
    const fused = new Map();
    const perLimit = Math.max(limit * 2, 10);
    let corrections = [];
    for (const q of list) {
      let hits = this._searchOne(q, { limit: perLimit, docId, k, contentType, proximity });
      if (hits.length === 0 && fuzzy) {
        const corr = this._fuzzyCorrect(q, { docId });
        if (corr) {
          corrections.push({ from: q, to: corr });
          hits = this._searchOne(corr, { limit: perLimit, docId, k, contentType, proximity });
        }
      }
      hits.forEach((h, i) => {
        const key = `${h.docId} ${h.chunk}`;
        let e = fused.get(key);
        if (!e) {
          e = { ...h, score: 0 };
          fused.set(key, e);
        }
        e.score += 1 / (k + i + 1);
        if (!e.snippet && h.snippet) e.snippet = h.snippet;
      });
    }

    let out = [...fused.values()]
      .sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) || a.chunk - b.chunk)
      .slice(0, limit);

    out = this._annotateStale(out, { checkStale, readFile, exists });
    if (corrections.length) {
      for (const h of out) h.correctedFrom = corrections;
    }
    return out;
  }

  // A short vocabulary of the most frequent significant terms across a document's
  // chunks. Deterministic (frequency desc, then alphabetical).
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

  // Local measured summary (NOT a hosted SaaS clone). Extends stats with
  // kind breakdown + expiry counts. Never emits $/% savings claims.
  report({ now = 0 } = {}) {
    const base = this.stats();
    const kinds = this.db.prepare(
      `SELECT COALESCE(content_kind, 'unknown') AS kind, COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes
       FROM docs GROUP BY 1 ORDER BY kind`
    ).all().map((r) => ({ kind: r.kind, docs: Number(r.n), bytes: Number(r.bytes) }));
    const expired = Number(
      this.db.prepare(
        'SELECT COUNT(*) AS n FROM docs WHERE expires_at IS NOT NULL AND expires_at <= ?'
      ).get(now).n
    );
    const withPath = Number(
      this.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE path IS NOT NULL AND path != \'\'').get().n
    );
    const withTtl = Number(
      this.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE expires_at IS NOT NULL').get().n
    );
    return {
      ...base,
      byKind: kinds,
      expiredDocs: expired,
      pathTrackedDocs: withPath,
      ttlTrackedDocs: withTtl,
      honesty: 'Measured indexed bytes and document counts only — no dollar or percentage savings claims.',
    };
  }

  // Drop docs whose expires_at has passed. Returns removed count.
  purgeExpired({ now = 0 } = {}) {
    const rows = this.db.prepare(
      'SELECT id FROM docs WHERE expires_at IS NOT NULL AND expires_at <= ?'
    ).all(now);
    let removed = 0;
    for (const r of rows) {
      const out = this.purge({ docId: r.id });
      removed += out.removedDocs;
    }
    return { removedDocs: removed, at: now };
  }

  // The offload decision: inline small content, index+pointer for large content.
  offload(source, content, { threshold = OFFLOAD_THRESHOLD_BYTES, createdAt = 0, ...indexOpts } = {}) {
    const bytes = Buffer.byteLength(String(content));
    if (bytes <= threshold) return { inline: true, body: String(content), bytes };
    const p = this.index(source, content, { createdAt, ...indexOpts });
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

  // Maintenance: drop one document (docId) or clear the whole store.
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
