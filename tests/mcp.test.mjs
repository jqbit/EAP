// Tests for the EAP-Runtime MCP JSON-RPC dispatch layer (newline-delimited
// JSON-RPC 2.0). The dispatcher is pure/injected, so every tool is exercised
// with crafted request objects — no live stdio loop needed.
// Run: node --test tests/mcp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, dispatchLine, TOOLS, PROTOCOL_VERSION } from '../layers/eap-runtime/src/mcp.mjs';
import { RuntimeStore } from '../layers/eap-runtime/src/store.mjs';
import { SessionLog } from '../layers/eap-runtime/src/session.mjs';

const EXPECTED_TOOLS = [
  'eap_execute', 'eap_index', 'eap_search', 'eap_stats',
  'eap_offload', 'eap_session_snapshot', 'eap_session_restore',
];

function harness() {
  const store = new RuntimeStore(':memory:');
  const session = new SessionLog(store);
  let t = 0;
  const dispatch = createDispatcher({ store, session, now: () => ++t });
  return { store, session, dispatch };
}

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (dispatch, id, name, args = {}) =>
  dispatch(req(id, 'tools/call', { name, arguments: args }));

test('initialize and tools/list expose all seven eap_* tools', async () => {
  const { dispatch } = harness();
  const init = await dispatch(req(1, 'initialize', {}));
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(init.result.serverInfo.name, 'eap-runtime');

  const list = await dispatch(req(2, 'tools/list'));
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const t of list.result.tools) {
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('unknown method returns JSON-RPC -32601 with the request id', async () => {
  const { dispatch } = harness();
  const res = await dispatch(req(9, 'resources/read', {}));
  assert.equal(res.id, 9);
  assert.equal(res.error.code, -32601);
  assert.match(res.error.message, /resources\/read/);
  assert.equal(res.result, undefined);
});

test('unknown tool returns -32602; invalid request returns -32600; bad JSON line returns -32700', async () => {
  const { dispatch } = harness();
  const unknownTool = await call(dispatch, 3, 'eap_teleport', {});
  assert.equal(unknownTool.error.code, -32602);

  const invalid = await dispatch({ id: 4, method: 'tools/list' }); // missing jsonrpc
  assert.equal(invalid.error.code, -32600);

  const parseErr = await dispatchLine(dispatch, '{not json');
  assert.equal(parseErr.error.code, -32700);
  assert.equal(parseErr.id, null);
});

test('notifications get no response', async () => {
  const { dispatch } = harness();
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('eap_index then eap_search round-trips exact chunks; eap_stats measures it', async () => {
  const { dispatch } = harness();
  const idx = await call(dispatch, 1, 'eap_index', {
    source: 'access.log',
    content: 'GET /health 200 4ms\n\nPOST /login 500 db timeout',
  });
  assert.equal(idx.result.isError, false);
  const pointer = idx.result.structuredContent.id;
  assert.ok(pointer.startsWith('eap_'));

  const found = await call(dispatch, 2, 'eap_search', { query: 'timeout', docId: pointer });
  const hits = found.result.structuredContent.hits;
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /db timeout/); // lossless, not a summary

  const stats = await call(dispatch, 3, 'eap_stats');
  assert.equal(stats.result.structuredContent.docs, 1);
  assert.ok(stats.result.structuredContent.bytesKeptOut > 0);
});

test('eap_offload: small inline, large becomes a pointer', async () => {
  const { dispatch } = harness();
  const small = await call(dispatch, 1, 'eap_offload', { source: 'note', content: 'short' });
  assert.equal(small.result.structuredContent.inline, true);

  const big = await call(dispatch, 2, 'eap_offload', {
    source: 'huge.log',
    content: 'needle-42\n\n' + 'noise '.repeat(200),
    threshold: 64,
  });
  assert.equal(big.result.structuredContent.inline, false);
  assert.ok(big.result.structuredContent.pointer);
  assert.match(big.result.structuredContent.hint, /eap_search/);
});

test('eap_execute runs a real subprocess through dispatch; deny-listed script is refused', async () => {
  const { dispatch } = harness();
  const ok = await call(dispatch, 1, 'eap_execute', { script: 'console.log(2 + 2)', language: 'node' });
  assert.equal(ok.result.isError, false);
  assert.equal(ok.result.structuredContent.ok, true);
  assert.equal(ok.result.structuredContent.output.trim(), '4');

  const denied = await call(dispatch, 2, 'eap_execute', { script: 'curl http://example.com' });
  assert.equal(denied.result.structuredContent.ok, false);
  assert.equal(denied.result.structuredContent.error, 'network-denied');
  assert.match(denied.result.structuredContent.message, /eap_fetch/);
});

test('missing required argument surfaces as an isError tool result, not a crash', async () => {
  const { dispatch } = harness();
  const res = await call(dispatch, 1, 'eap_index', { source: 'x' }); // no content
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /content/);
});

test('session snapshot/restore via dispatch; tool calls are auto-logged as events', async () => {
  const { dispatch, session } = harness();
  await call(dispatch, 1, 'eap_index', { source: 'notes.txt', content: 'alpha beta' });
  await call(dispatch, 2, 'eap_stats');

  const snap = await call(dispatch, 3, 'eap_session_snapshot', { ts: 1234 });
  const sc = snap.result.structuredContent;
  assert.equal(sc.ts, 1234);
  assert.ok(sc.bytes <= 2048);
  assert.match(sc.body, /eap_index \(notes\.txt\)/); // the auto-logged tool event

  const back = await call(dispatch, 4, 'eap_session_restore');
  assert.equal(back.result.structuredContent.body, sc.body);
  assert.ok(session.events().length >= 2);
});

test('dispatchLine handles a full JSON-RPC line end-to-end (framing: one message per line)', async () => {
  const { dispatch } = harness();
  const line = JSON.stringify(req(7, 'tools/call', {
    name: 'eap_stats',
    arguments: {},
  }));
  assert.ok(!line.includes('\n'), 'serialized frames must be single-line');
  const res = await dispatchLine(dispatch, line);
  assert.equal(res.id, 7);
  assert.equal(res.result.structuredContent.docs, 0);
});
