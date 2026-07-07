// Unit tests for the pure EAP hook dispatcher (src/hooks/eap-dispatch.mjs).
// Run: node --test tests/dispatch.test.mjs
//
// The dispatcher is a pure function of its injected deps, so these tests inject
// an in-memory Runtime store/session — no disk, no stdio, deterministic clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, DEFAULT_OFFLOAD_THRESHOLD } from '../src/hooks/eap-dispatch.mjs';
import { RuntimeStore } from '../layers/eap-runtime/src/store.mjs';
import { SessionLog } from '../layers/eap-runtime/src/session.mjs';

function mkRuntime() {
  const store = new RuntimeStore(':memory:');
  const session = new SessionLog(store);
  return { store, session };
}

test('SessionStart emits the Voice rules (plus the Context-graph note when available)', async () => {
  const runtime = mkRuntime();
  const r = await dispatch('SessionStart', {}, {
    voiceRules: 'VOICE-RULES-MARKER: verdict first, filler never.',
    runtime, contextAvailable: true, now: () => 1,
  });
  assert.equal(r.event, 'SessionStart');
  assert.match(r.additionalContext, /VOICE-RULES-MARKER/);
  assert.match(r.additionalContext, /eap_graph_query/);
  runtime.store.close();
});

test('SessionStart rehydrates the last Runtime snapshot when one exists', async () => {
  const runtime = mkRuntime();
  runtime.session.append({ ts: 1, kind: 'decision', summary: 'RESUME-DECISION-42 ship the pointer format' });
  runtime.session.snapshot({ ts: 2 });
  const r = await dispatch('SessionStart', {}, { voiceRules: 'V', runtime, contextAvailable: false, now: () => 3 });
  assert.match(r.additionalContext, /RESUME-DECISION-42/);
  assert.match(r.additionalContext, /EAP-Runtime resume/);
  runtime.store.close();
});

test('PostToolUse offloads an oversized payload to a searchable pointer', async () => {
  const runtime = mkRuntime();
  const big = 'alpha beta gamma '.repeat(20000); // well over the threshold
  assert.ok(big.length > DEFAULT_OFFLOAD_THRESHOLD);
  const r = await dispatch('PostToolUse',
    { tool_name: 'Read', tool_input: { file_path: '/var/log/huge.log' }, tool_response: big },
    { runtime, now: () => 5 });
  assert.equal(r.offload.inline, false);
  assert.match(r.offload.pointer, /^eap_/);
  assert.match(r.additionalContext, /kept out of context/);
  assert.match(r.additionalContext, /eap_search/);
  // The offload is logged so it survives into the next snapshot.
  assert.ok(runtime.session.events().some((e) => /offloaded/.test(e.summary)));
  runtime.store.close();
});

test('PostToolUse leaves a small payload inline (no pointer)', async () => {
  const runtime = mkRuntime();
  const r = await dispatch('PostToolUse',
    { tool_name: 'Read', tool_response: 'a short result' }, { runtime, now: () => 0 });
  assert.ok(!r.offload || r.offload.inline === true);
  assert.ok(!r.additionalContext);
  runtime.store.close();
});

test('PreCompact persists a priority-tiered session snapshot', async () => {
  const runtime = mkRuntime();
  runtime.session.append({ ts: 1, kind: 'decision', summary: 'SNAP-DECISION-D1' });
  runtime.session.append({ ts: 2, kind: 'tool', summary: 'ran the tests' });
  const r = await dispatch('PreCompact', {}, { runtime, now: () => 9 });
  assert.ok(r.snapshot);
  assert.match(r.snapshot.body, /SNAP-DECISION-D1/);
  // Persisted: a subsequent restore returns the same body.
  assert.equal(runtime.session.restore().body, r.snapshot.body);
  runtime.store.close();
});

test('PreToolUse nudges toward the graph before a large raw read', async () => {
  const r = await dispatch('PreToolUse',
    { tool_name: 'Read', tool_input: { file_path: '/x' } }, { contextAvailable: true });
  assert.match(r.additionalContext || '', /eap_graph_query/);
});

test('PreToolUse stays silent for non-read tools', async () => {
  const r = await dispatch('PreToolUse', { tool_name: 'Bash' }, { contextAvailable: true });
  assert.ok(!r.additionalContext);
});

test('silent-fail: bad input / missing deps never throw, always return { event }', async () => {
  for (const ev of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreCompact']) {
    const r = await dispatch(ev, null, {});      // null input, no deps at all
    assert.equal(typeof r, 'object');
    assert.equal(r.event, ev);
  }
  // A runtime whose methods throw must not surface the error.
  const explodingRuntime = {
    store: { offload() { throw new Error('boom'); } },
    session: { snapshot() { throw new Error('boom'); }, restore() { throw new Error('boom'); }, append() { throw new Error('boom'); } },
  };
  const post = await dispatch('PostToolUse', { tool_response: 'x'.repeat(200 * 1024) }, { runtime: explodingRuntime });
  assert.equal(post.event, 'PostToolUse');
  const pre = await dispatch('PreCompact', {}, { runtime: explodingRuntime });
  assert.equal(pre.event, 'PreCompact');
  // An unknown event is handled gracefully too.
  const unknown = await dispatch('TotallyUnknownEvent', {}, {});
  assert.equal(unknown.event, 'TotallyUnknownEvent');
});
