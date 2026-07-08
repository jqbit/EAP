// Tests for the EAP-Runtime MCP JSON-RPC dispatch layer (newline-delimited
// JSON-RPC 2.0). The dispatcher is pure/injected, so every tool is exercised
// with crafted request objects — no live stdio loop needed.
// Run: node --test tests/mcp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDispatcher, dispatchLine, TOOLS, PROTOCOL_VERSION } from '../layers/eap-runtime/src/mcp.mjs';
import { RuntimeStore } from '../layers/eap-runtime/src/store.mjs';
import { SessionLog } from '../layers/eap-runtime/src/session.mjs';
import { fetchUrl, assessHostIp, htmlToText, clearFetchCache } from '../layers/eap-runtime/src/fetch.mjs';

const EXPECTED_TOOLS = [
  'eap_execute', 'eap_execute_file', 'eap_batch_execute',
  'eap_index', 'eap_search', 'eap_fetch', 'eap_fetch_and_index',
  'eap_stats', 'eap_offload', 'eap_purge', 'eap_doctor',
  'eap_session_snapshot', 'eap_session_restore',
];

function harness() {
  const store = new RuntimeStore(':memory:');
  const session = new SessionLog(store);
  let t = 0;
  const dispatch = createDispatcher({ store, session, now: () => ++t });
  return { store, session, dispatch };
}

// A harness with an injected fetch stub + memory probe, so network tools are
// exercised without any real egress.
function harnessWith({ fetch, memoryProbe } = {}) {
  const store = new RuntimeStore(':memory:');
  const session = new SessionLog(store);
  let t = 0;
  const dispatch = createDispatcher({ store, session, fetch, memoryProbe, now: () => ++t });
  return { store, session, dispatch };
}

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (dispatch, id, name, args = {}) =>
  dispatch(req(id, 'tools/call', { name, arguments: args }));
const sc = (res) => res.result.structuredContent;

test('initialize and tools/list expose every eap_* tool', async () => {
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

test('eap_execute with intent returns filtered chunks + vocabulary through dispatch', async () => {
  const { dispatch } = harness();
  // Produce > 100 KB so the store's default offload threshold triggers through
  // dispatch (which does not expose a custom threshold).
  const script = [
    'for i in range(8000):',
    '    print(f"noise line {i} status ok metric latency handled cleanly")',
    'print("CRITICAL disk full on volume data-7")',
  ].join('\n');
  const r = await call(dispatch, 1, 'eap_execute', {
    script, language: 'python3', intent: 'disk full volume',
  });
  const v = sc(r);
  assert.equal(v.offloaded, true);
  assert.equal(v.intent, 'disk full volume');
  assert.ok(v.matches.length >= 1);
  assert.match(v.matches[0].body, /disk full/);
  assert.ok(Array.isArray(v.vocabulary) && v.vocabulary.length > 0);
});

test('eap_execute_file runs a script file from disk via dispatch', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eap-mcpfile-'));
  const f = path.join(dir, 'go.py');
  fs.writeFileSync(f, 'print("mcp-file", 9 * 9)');
  const { dispatch } = harness();
  const r = await call(dispatch, 1, 'eap_execute_file', { path: f });
  assert.equal(sc(r).ok, true);
  assert.match(sc(r).output, /mcp-file 81/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('eap_batch_execute runs a bounded batch via dispatch', async () => {
  const { dispatch } = harness();
  const r = await call(dispatch, 1, 'eap_batch_execute', {
    scripts: [
      { script: 'print(2*3)', language: 'python3' },
      { script: 'console.log("hi")', language: 'node' },
    ],
  });
  assert.equal(sc(r).count, 2);
  assert.equal(sc(r).results[0].output.trim(), '6');
});

test('eap_doctor self-checks node, sqlite, runtimes, and store health', async () => {
  const { dispatch } = harness();
  const r = await call(dispatch, 1, 'eap_doctor');
  const d = sc(r);
  assert.match(d.node, /^v\d+/);
  assert.equal(d.sqlite.ok, true);
  assert.equal(d.sqlite.trigram, true);
  assert.equal(typeof d.runtimes.python3.available, 'boolean');
  assert.equal(typeof d.runtimes.ruby.available, 'boolean');
  assert.equal(d.store.ok, true);
});

test('eap_purge clears a single doc and then the whole store', async () => {
  const { dispatch } = harness();
  const idx = await call(dispatch, 1, 'eap_index', { source: 'a', content: 'alpha here' });
  await call(dispatch, 2, 'eap_index', { source: 'b', content: 'beta here' });
  const one = await call(dispatch, 3, 'eap_purge', { docId: sc(idx).id });
  assert.equal(sc(one).removedDocs, 1);
  const all = await call(dispatch, 4, 'eap_purge', {});
  assert.equal(sc(all).removedDocs, 1);
  assert.equal(sc(await call(dispatch, 5, 'eap_stats')).docs, 0);
});

test('eap_stats reports a measured token estimate (no % or $ headline)', async () => {
  const { dispatch } = harness();
  await call(dispatch, 1, 'eap_index', { source: 'x', content: 'y'.repeat(800) });
  const st = sc(await call(dispatch, 2, 'eap_stats'));
  assert.equal(st.bytesKeptOut, 800);
  assert.equal(st.estimatedTokens, 200);
  assert.match(st.estimateBasis, /heuristic|estimate/i);
});

test('eap_fetch (injected) offloads small text inline and large text to a pointer', async () => {
  const stub = async (url) => ({
    ok: true, status: 200, url, finalUrl: url, contentType: 'text/html',
    bytes: 11, truncated: false, cached: false,
    text: url.includes('big') ? 'needle-77 ' + 'pad '.repeat(50000) : 'hello world',
  });
  const { dispatch } = harnessWith({ fetch: stub });
  const small = sc(await call(dispatch, 1, 'eap_fetch', { url: 'http://example.com/small' }));
  assert.equal(small.ok, true);
  assert.equal(small.offloaded, false);
  assert.equal(small.text, 'hello world');

  const big = sc(await call(dispatch, 2, 'eap_fetch', { url: 'http://example.com/big' }));
  assert.equal(big.offloaded, true);
  assert.ok(big.pointer);
  assert.match(big.hint, /eap_search/);
});

test('eap_fetch surfaces an SSRF block from the fetch layer as a structured error', async () => {
  const stub = async () => ({ ok: false, error: 'ssrf-blocked', reason: 'blocked host 169.254.169.254: IMDS' });
  const { dispatch } = harnessWith({ fetch: stub });
  const r = sc(await call(dispatch, 1, 'eap_fetch', { url: 'http://169.254.169.254/' }));
  assert.equal(r.error, 'ssrf-blocked');
});

test('eap_fetch_and_index (injected) indexes and returns a searchable pointer + vocabulary', async () => {
  const stub = async (url) => ({
    ok: true, status: 200, url, finalUrl: url, contentType: 'text/html',
    bytes: 40, truncated: false, cached: false,
    text: 'The payments gateway returned a timeout error for order 42.',
  });
  const { dispatch } = harnessWith({ fetch: stub });
  const r = sc(await call(dispatch, 1, 'eap_fetch_and_index', { url: 'http://example.com/doc' }));
  assert.ok(r.pointer);
  assert.ok(Array.isArray(r.vocabulary) && r.vocabulary.includes('payments'));
  // The indexed body is now retrievable losslessly.
  const hits = sc(await call(dispatch, 2, 'eap_search', { query: 'timeout', docId: r.pointer })).hits;
  assert.match(hits[0].body, /gateway returned a timeout/);
});

test('eap_session_restore surfaces project memory pointers via the injected probe', async () => {
  const { dispatch } = harnessWith({ memoryProbe: () => ['CLAUDE.md'] });
  await call(dispatch, 1, 'eap_index', { source: 'n', content: 'note' });
  await call(dispatch, 2, 'eap_session_snapshot', { ts: 10 });
  const r = sc(await call(dispatch, 3, 'eap_session_restore'));
  assert.ok(Array.isArray(r.memory));
  assert.deepEqual(r.memory.map((m) => m.name), ['CLAUDE.md']);
  assert.match(r.body, /CLAUDE\.md/);
});

// ── SSRF-hardened fetch layer (unit, no dispatcher) ─────────────────────────

test('assessHostIp blocks IMDS, loopback, private, link-local, IPv4-mapped IMDS; allows public', () => {
  for (const ip of ['169.254.169.254', '127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1',
    '::1', 'fe80::1', 'fc00::1', '::ffff:169.254.169.254', '0.0.0.0', '100.64.0.1']) {
    assert.equal(assessHostIp(ip).blocked, true, `${ip} must be blocked`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    assert.equal(assessHostIp(ip).blocked, false, `${ip} must be allowed`);
  }
});

test('fetchUrl refuses non-http schemes and SSRF targets before connecting', async () => {
  clearFetchCache();
  assert.equal((await fetchUrl('ftp://example.com/')).error, 'scheme-blocked');
  assert.equal((await fetchUrl('file:///etc/passwd')).error, 'scheme-blocked');
  assert.equal((await fetchUrl('http://169.254.169.254/latest/meta-data/')).error, 'ssrf-blocked');
  assert.equal((await fetchUrl('http://127.0.0.1/')).error, 'ssrf-blocked');
  assert.equal((await fetchUrl('http://[::1]/')).error, 'ssrf-blocked');
  assert.equal((await fetchUrl('not a url')).error, 'bad-url');
});

test('fetchUrl fetches a loopback server (guard-injected), reduces HTML, and caps bytes', async () => {
  const server = http.createServer((rq, rs) => {
    if (rq.url === '/html') { rs.setHeader('content-type', 'text/html'); rs.end('<html><body><h1>Report</h1><p>rows &amp; cols</p></body></html>'); }
    else if (rq.url === '/big') { rs.end('D'.repeat(5000)); }
    else if (rq.url === '/redir') { rs.statusCode = 302; rs.setHeader('location', 'http://169.254.169.254/'); rs.end(); }
    else rs.end('plain');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const allowLoopback = (ip) => (ip === '127.0.0.1' ? { blocked: false, family: 4 } : assessHostIp(ip));
  clearFetchCache();

  const html = await fetchUrl(`${base}/html`, { guard: allowLoopback });
  assert.equal(html.ok, true);
  assert.match(html.text, /# Report/);
  assert.match(html.text, /rows & cols/);

  const capped = await fetchUrl(`${base}/big`, { guard: allowLoopback, maxBytes: 1000 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.bytes <= 1000);

  // A redirect to an SSRF target is re-validated on the hop and blocked.
  const redir = await fetchUrl(`${base}/redir`, { guard: allowLoopback });
  assert.equal(redir.error, 'ssrf-blocked');

  server.close();
});

test('htmlToText strips scripts/styles and renders links and lists', () => {
  const out = htmlToText('<style>x{}</style><script>bad()</script><h1>T</h1><p>a <a href="/u">link</a></p><ul><li>one</li><li>two</li></ul>');
  assert.doesNotMatch(out, /bad\(\)/);
  assert.match(out, /# T/);
  assert.match(out, /link \(\/u\)/);
  assert.match(out, /- one/);
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
