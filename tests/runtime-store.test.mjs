// Tests for the EAP-Runtime clean-room offload store.
// Run: node --test tests/runtime-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RuntimeStore, chunk, OFFLOAD_THRESHOLD_BYTES, probeSqlite, tokenize, STOPWORDS,
} from '../layers/eap-runtime/src/store.mjs';

test('chunk packs small paragraphs and caps oversized ones', () => {
  // Small paragraphs pack together up to maxChars (fewer, denser FTS rows).
  assert.deepEqual(chunk('a\n\nb\n\nc'), ['a\n\nb\n\nc']);
  // A tiny cap forces one paragraph per chunk.
  assert.deepEqual(chunk('a\n\nb\n\nc', 1), ['a', 'b', 'c']);
  // A single oversized paragraph is hard-split at the cap.
  const capped = chunk('x'.repeat(5000), 2000);
  assert.equal(capped.length, 3);
  assert.ok(capped.every(p => p.length <= 2000));
});

test('index + search returns exact (lossless) matching chunks, not summaries', () => {
  const s = new RuntimeStore(':memory:');
  const log = 'GET /health 200 4ms\n\nPOST /login 500 db timeout\n\nGET /users 200 12ms';
  const p = s.index('access.log', log);
  assert.ok(p.chunks >= 1);
  const hits = s.search('timeout');
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /db timeout/);        // exact bytes, not a summary
  assert.equal(hits[0].docId, p.id);
  s.close();
});

test('offload: small content stays inline, large content becomes a pointer', () => {
  const s = new RuntimeStore(':memory:');
  const small = s.offload('note', 'short');
  assert.equal(small.inline, true);
  assert.equal(small.body, 'short');

  const big = 'error line\n\n' + 'noise\n\n'.repeat(30000); // > threshold
  assert.ok(Buffer.byteLength(big.repeat(1)) > OFFLOAD_THRESHOLD_BYTES);
  const off = s.offload('huge.log', big);
  assert.equal(off.inline, false);
  assert.match(off.hint, /kept out of context/);
  // The offloaded content is still retrievable losslessly by pointer.
  const hits = s.search('error', { docId: off.pointer });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].body, /error line/);
  s.close();
});

test('indexing identical content is idempotent (deterministic id, no clock)', () => {
  const s = new RuntimeStore(':memory:');
  const a = s.index('x', 'same content here');
  const b = s.index('x', 'same content here');
  assert.equal(a.id, b.id);
  assert.equal(b.deduped, true);
  assert.equal(s.stats().docs, 1);
  s.close();
});

test('stats reports measured bytes kept out of context (a real sum, not a %)', () => {
  const s = new RuntimeStore(':memory:');
  s.index('a', 'hello world');
  s.index('b', 'another document body');
  const st = s.stats();
  assert.equal(st.docs, 2);
  assert.equal(st.bytesKeptOut, Buffer.byteLength('hello world') + Buffer.byteLength('another document body'));
  s.close();
});

test('search query with FTS punctuation is treated as data, not syntax', () => {
  const s = new RuntimeStore(':memory:');
  s.index('code', 'call foo() then bar()');
  // A raw `foo()` would be an FTS syntax error if not escaped.
  const hits = s.search('foo()');
  assert.ok(hits.length >= 1);
  s.close();
});

test('trigram fusion (RRF) finds a mid-token substring the keyword ranker alone would miss', () => {
  const s = new RuntimeStore(':memory:');
  s.index('report', 'Quarterly revenue grew nine percent.');
  // "uarter" is a substring of "Quarterly" but not a porter stem of any token,
  // so only the trigram side matches. RRF still surfaces the exact chunk.
  const hits = s.search('uarter');
  assert.ok(hits.length >= 1, 'trigram substring match expected');
  assert.match(hits[0].body, /Quarterly revenue grew/); // lossless full chunk
  s.close();
});

test('search results carry a locator snippet but keep the exact body (lossless)', () => {
  const s = new RuntimeStore(':memory:');
  s.index('log', 'GET /health 200\n\nPOST /login 500 db timeout here\n\nGET /x 200');
  const hits = s.search('timeout');
  assert.equal(hits.length, 1);
  assert.equal(typeof hits[0].snippet, 'string');
  assert.ok(hits[0].snippet.length > 0);
  assert.match(hits[0].body, /db timeout here/); // body is the exact chunk, not the snippet
  s.close();
});

test('title/source weighting boosts a chunk whose source label matches the query', () => {
  const s = new RuntimeStore(':memory:');
  // Both bodies match the query equally; the tie-breaker is the source label.
  const body = 'the payments module writes many log lines here and here and here';
  const inSource = s.index('payments.log', body);     // source ALSO contains "payments"
  s.index('misc-notes', body);                        // identical body, neutral source
  const hits = s.search('payments', { limit: 5 });
  assert.ok(hits.length >= 2, 'both bodies match the query');
  assert.equal(hits[0].docId, inSource.id, 'source-matching doc should rank first');
  s.close();
});

test('vocabulary returns frequent significant terms, dropping stopwords and pure numbers', () => {
  const s = new RuntimeStore(':memory:');
  const p = s.index('doc', 'the payment payment failed 500 500 500 because the gateway gateway timed out');
  const vocab = s.vocabulary(p.id, { limit: 10 });
  assert.ok(vocab.includes('payment'));
  assert.ok(vocab.includes('gateway'));
  assert.ok(!vocab.includes('the'), 'stopwords excluded');
  assert.ok(!vocab.includes('500'), 'pure-number tokens excluded');
  s.close();
});

test('purge drops one document or clears the whole store', () => {
  const s = new RuntimeStore(':memory:');
  const a = s.index('a', 'alpha content here');
  s.index('b', 'beta content here');
  assert.equal(s.stats().docs, 2);

  const one = s.purge({ docId: a.id });
  assert.equal(one.removedDocs, 1);
  assert.equal(s.stats().docs, 1);
  assert.equal(s.search('alpha').length, 0, 'purged doc no longer retrievable');
  assert.ok(s.search('beta').length >= 1, 'other doc survives');

  const all = s.purge();
  assert.equal(all.removedDocs, 1);
  assert.equal(s.stats().docs, 0);
  s.close();
});

test('stats reports an honest estimated token count (~bytes/4), labelled as an estimate', () => {
  const s = new RuntimeStore(':memory:');
  s.index('a', 'x'.repeat(400));
  const st = s.stats();
  assert.equal(st.bytesKeptOut, 400);
  assert.equal(st.estimatedTokens, 100); // ceil(400/4)
  assert.match(st.estimateBasis, /estimate|heuristic/i);
  assert.ok(!('dollars' in st) && !('percent' in st), 'no dollar/percent headline');
  s.close();
});

test('health() runs a sqlite integrity check and includes measured stats', () => {
  const s = new RuntimeStore(':memory:');
  s.index('a', 'hello world');
  const h = s.health();
  assert.equal(h.ok, true);
  assert.equal(h.integrity, 'ok');
  assert.equal(h.docs, 1);
  s.close();
});

test('probeSqlite confirms node:sqlite + FTS5 porter and trigram tokenizers', () => {
  const p = probeSqlite();
  assert.equal(p.ok, true);
  assert.equal(p.fts5, true);
  assert.equal(p.trigram, true);
});

test('tokenize/STOPWORDS helpers are Unicode-aware and expose the stopword set', () => {
  assert.deepEqual(tokenize('Foo_Bar baz-qux 42'), ['foo_bar', 'baz', 'qux', '42']);
  assert.ok(STOPWORDS.has('the'));
  assert.ok(!STOPWORDS.has('timeout'));
});

test('file-backed store enables WAL + busy_timeout so concurrent multi-agent opens do not hard-fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eap-store-wal-'));
  const dbPath = join(dir, 'runtime.db');
  const a = new RuntimeStore(dbPath);
  const b = new RuntimeStore(dbPath);
  try {
    const mode = a.db.prepare('PRAGMA journal_mode').get().journal_mode;
    const timeout = a.db.prepare('PRAGMA busy_timeout').get().timeout;
    assert.equal(String(mode).toLowerCase(), 'wal');
    assert.equal(timeout, 5000);
    a.index('src-a', 'alpha concurrent payload');
    b.index('src-b', 'beta concurrent payload');
    assert.ok(a.search('alpha').length >= 1);
    assert.ok(b.search('beta').length >= 1);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
