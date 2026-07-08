// Tests for EAP-Runtime session continuity (event log + tiered snapshot).
// Run: node --test tests/session.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionLog, buildSnapshot, tierOf, classifyError, EVENT_KINDS, SNAPSHOT_MAX_BYTES,
} from '../layers/eap-runtime/src/session.mjs';
import { RuntimeStore } from '../layers/eap-runtime/src/store.mjs';

test('snapshot/restore round-trip on the shared store db', () => {
  const store = new RuntimeStore(':memory:');
  const log = new SessionLog(store);
  assert.equal(log.restore(), null, 'no snapshot before the first PreCompact');

  log.append({ ts: 1, kind: 'tool', summary: 'eap_execute parsed access.log' });
  log.append({ ts: 2, kind: 'edit', summary: 'wrote src/executor.mjs' });
  log.append({ ts: 3, kind: 'decision', summary: 'use lexical FTS for retrieval' });

  const snap = log.snapshot({ ts: 4 });
  assert.equal(snap.events, 3);
  assert.match(snap.body, /\[decision\] use lexical FTS for retrieval @3/);
  assert.match(snap.body, /\[edit\] wrote src\/executor\.mjs @2/);
  assert.match(snap.body, /\[tool\] eap_execute parsed access\.log @1/);

  const back = log.restore();
  assert.equal(back.body, snap.body);
  assert.equal(back.ts, 4);
  assert.equal(back.bytes, snap.bytes);
  store.close();
});

test('snapshot is priority-tiered: a decision survives a flood of tool chatter', () => {
  const store = new RuntimeStore(':memory:');
  const log = new SessionLog(store);
  for (let i = 0; i < 60; i++) {
    log.append({ ts: i, kind: 'tool', summary: `tool call number ${i} with routine padding text` });
  }
  log.append({ ts: 5, kind: 'decision', summary: 'KEY-DECISION-77 ship the pointer format' });

  const snap = log.snapshot({ ts: 100, maxBytes: 300 });
  assert.ok(snap.bytes <= 300, `snapshot must respect the cap (got ${snap.bytes})`);
  // The old decision beats all newer tool events despite its early timestamp.
  assert.match(snap.body, /KEY-DECISION-77/);
  assert.match(snap.body, /more event\(s\) in the store/);
  store.close();
});

test('default size cap (~2KB) holds under heavy event volume', () => {
  const store = new RuntimeStore(':memory:');
  const log = new SessionLog(store);
  for (let i = 0; i < 200; i++) {
    log.append({ ts: i, kind: i % 3 === 0 ? 'decision' : 'tool', summary: `event ${i} ` + 'y'.repeat(120) });
  }
  const snap = log.snapshot({ ts: 999 });
  assert.ok(snap.bytes <= SNAPSHOT_MAX_BYTES, `got ${snap.bytes} > ${SNAPSHOT_MAX_BYTES}`);
  assert.equal(Buffer.byteLength(snap.body), snap.bytes);
  store.close();
});

test('deterministic: injected timestamps, identical inputs -> identical snapshots', () => {
  const build = () => {
    const store = new RuntimeStore(':memory:');
    const log = new SessionLog(store);
    log.append({ ts: 10, kind: 'error', summary: 'lint failed on session.mjs' });
    log.append({ ts: 11, kind: 'tool', summary: 'ran tests' });
    const s = log.snapshot({ ts: 42 });
    store.close();
    return s.body;
  };
  assert.equal(build(), build());
  // The pure builder is deterministic too (no clock anywhere in the module).
  const events = [
    { ts: 1, kind: 'tool', summary: 'a' },
    { ts: 2, kind: 'decision', summary: 'b' },
  ];
  assert.equal(buildSnapshot(events, { ts: 7 }), buildSnapshot(events, { ts: 7 }));
  assert.match(buildSnapshot(events, { ts: 7 }), /@7 — 2 event\(s\)/);
});

test('tier order: decision/error > edit > tool > unknown', () => {
  assert.equal(tierOf('decision'), 0);
  assert.equal(tierOf('error'), 0);
  assert.equal(tierOf('edit'), 1);
  assert.equal(tierOf('tool'), 2);
  assert.ok(tierOf('whatever') > tierOf('tool'));
});

test('append validates shape: ts must be injected, kind/summary non-empty', () => {
  const store = new RuntimeStore(':memory:');
  const log = new SessionLog(store);
  assert.throws(() => log.append({ kind: 'tool', summary: 'no ts' }), TypeError);
  assert.throws(() => log.append({ ts: 1, kind: '', summary: 'x' }), TypeError);
  assert.throws(() => log.append({ ts: 1, kind: 'tool', summary: '' }), TypeError);
  store.close();
});

test('multi-line summaries are flattened so framing stays one-line-safe', () => {
  const events = [{ ts: 1, kind: 'note', summary: 'line one\nline two\n\nline three' }];
  const body = buildSnapshot(events, { ts: 2 });
  assert.match(body, /line one line two line three/);
});

test('extended taxonomy keeps the public tier contract and slots new kinds', () => {
  // Contract preserved: decision/error=0, edit=1, tool=2, unknown below all.
  assert.equal(tierOf('decision'), 0);
  assert.equal(tierOf('edit'), 1);
  assert.equal(tierOf('tool'), 2);
  // New kinds land in sensible tiers.
  assert.equal(tierOf('rule'), 0);
  assert.equal(tierOf('task'), 1);
  assert.equal(tierOf('file_write'), 1);
  assert.equal(tierOf('file_read'), 2);
  assert.equal(tierOf('git'), 2);
  assert.equal(tierOf('intent'), 2);
  assert.equal(tierOf('cwd'), 3);
  assert.equal(tierOf('subagent'), 3);
  assert.ok(tierOf('totally-unknown') > tierOf('cwd'));
  // The taxonomy is discoverable and includes the newly-added kinds.
  for (const k of ['file_read', 'file_write', 'cwd', 'git', 'task', 'rule', 'env', 'skill', 'subagent', 'intent']) {
    assert.ok(EVENT_KINDS.includes(k), `EVENT_KINDS should include ${k}`);
  }
});

test('classifyError buckets error summaries into a small deterministic vocabulary', () => {
  assert.equal(classifyError('operation timed out after 30s'), 'timeout');
  assert.equal(classifyError('ECONNREFUSED connecting to socket'), 'network');
  assert.equal(classifyError('EACCES permission denied'), 'permission');
  assert.equal(classifyError('ENOENT no such file or directory'), 'not-found');
  assert.equal(classifyError('SyntaxError: unexpected token'), 'syntax');
  assert.equal(classifyError('runtime-not-available: ruby not installed'), 'runtime');
  assert.equal(classifyError('something else entirely'), 'other');
});

test('snapshot tags error lines with their classification and carries per-section hints', () => {
  const events = [
    { ts: 3, kind: 'decision', summary: 'ship the pointer format' },
    { ts: 2, kind: 'error', summary: 'fetch failed: ECONNREFUSED' },
    { ts: 1, kind: 'tool', summary: 'ran the parser' },
  ];
  const body = buildSnapshot(events, { ts: 9 });
  assert.match(body, /\[error:network\] fetch failed/); // classified inline
  assert.match(body, /\[decision\] ship the pointer format/);
  // Per-section runnable retrieval hints are present.
  assert.match(body, /eap_session_restore\(\)/);
  assert.match(body, /eap_search/);
});

test('snapshot with section hints still respects the hard byte cap', () => {
  const store = new RuntimeStore(':memory:');
  const log = new SessionLog(store);
  for (let i = 0; i < 80; i++) log.append({ ts: i, kind: 'file_read', summary: `read file ${i} ` + 'z'.repeat(80) });
  log.append({ ts: 5, kind: 'decision', summary: 'DECIDED-XYZ pick RRF fusion' });
  const snap = log.snapshot({ ts: 500, maxBytes: 400 });
  assert.ok(snap.bytes <= 400, `cap must hold with hints (got ${snap.bytes})`);
  assert.match(snap.body, /DECIDED-XYZ/);
  store.close();
});

test('restore surfaces project memory files as pointers without reading their content', () => {
  const store = new RuntimeStore(':memory:');
  const log = new SessionLog(store);
  log.append({ ts: 1, kind: 'decision', summary: 'baseline decision' });
  const persisted = log.snapshot({ ts: 2 });

  // No memoryFiles: byte-for-byte identical to the persisted snapshot.
  assert.equal(log.restore().body, persisted.body);
  assert.equal(log.restore().memory, undefined);

  // With memoryFiles: presence surfaced as a pointer; content NOT injected.
  const withMem = log.restore({ memoryFiles: ['CLAUDE.md', 'AGENTS.md'] });
  assert.ok(Array.isArray(withMem.memory));
  assert.deepEqual(withMem.memory.map((m) => m.name), ['CLAUDE.md', 'AGENTS.md']);
  assert.match(withMem.body, /project memory/);
  assert.match(withMem.body, /CLAUDE\.md/);
  assert.match(withMem.body, /not injected/);
  store.close();
});

test('restore with no snapshot still surfaces memory pointers when present', () => {
  const store = new RuntimeStore(':memory:');
  const log = new SessionLog(store);
  assert.equal(log.restore(), null, 'nothing at all when no snapshot and no memory');
  const r = log.restore({ memoryFiles: ['CLAUDE.md'] });
  assert.equal(r.ts, null);
  assert.match(r.body, /CLAUDE\.md/);
  assert.deepEqual(r.memory.map((m) => m.name), ['CLAUDE.md']);
  store.close();
});
