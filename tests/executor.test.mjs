// Tests for the EAP-Runtime "think in code" executor.
// Run: node --test tests/executor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeScript, checkNetworkPolicy } from '../layers/eap-runtime/src/executor.mjs';
import { RuntimeStore } from '../layers/eap-runtime/src/store.mjs';

test('runs a real python3 script; only printed stdout returns', async () => {
  const r = await executeScript('print(sum(range(1, 11)))', { language: 'python3' });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.offloaded, false);
  assert.equal(r.output.trim(), '55');
});

test('runs a real node script', async () => {
  const r = await executeScript('console.log(6 * 7)', { language: 'node' });
  assert.equal(r.ok, true);
  assert.equal(r.output.trim(), '42');
});

test('runs bash; stderr is captured separately from stdout', async () => {
  const r = await executeScript('echo summary-line; echo warn-line >&2', { language: 'bash' });
  assert.equal(r.ok, true);
  assert.equal(r.output.trim(), 'summary-line');
  assert.match(r.stderr, /warn-line/);
});

test('non-zero exit is reported, stdout still returned', async () => {
  const r = await executeScript('print("partial")\nraise SystemExit(3)', { language: 'python3' });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.output.trim(), 'partial');
});

test('unsupported language is refused with a clear message', async () => {
  const r = await executeScript('puts 1', { language: 'ruby' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unsupported-language');
  assert.match(r.message, /python3/);
});

test('network deny-list refuses curl/wget/nc and inline HTTP, pointing to eap_fetch', async () => {
  const denied = [
    'curl http://example.com/data.json',
    'wget -q http://example.com',
    'nc example.com 80',
    "fetch('http://example.com/api')",
    'const r = await fetch("https://example.com")',
    "import requests\nrequests.get('http://example.com')",
    'import urllib.request',
    'import http.client',
    "const s = net.connect(80, 'example.com')",
  ];
  for (const script of denied) {
    const r = await executeScript(script, { language: 'bash' });
    assert.equal(r.ok, false, `should refuse: ${script}`);
    assert.equal(r.error, 'network-denied');
    assert.match(r.message, /eap_fetch/);
  }
  // The pure policy check is directly testable — no subprocess, no network.
  assert.equal(checkNetworkPolicy('print("hello")').allowed, true);
  assert.equal(checkNetworkPolicy('curl http://x').allowed, false);
  assert.equal(checkNetworkPolicy('curl http://x').match, 'curl');
  // Local-only fetch of a variable URL string is not the inline-literal form.
  assert.equal(checkNetworkPolicy('function prefetchCache(x) { return x; }').allowed, true);
});

test('large stdout is offloaded through the store and returns a searchable pointer', async () => {
  const store = new RuntimeStore(':memory:');
  const script = [
    'for i in range(400):',
    '    print(f"logline {i} status=200 ok")',
    'print("needle-9137 status=500 db timeout")',
  ].join('\n');
  const r = await executeScript(script, {
    language: 'python3',
    store,
    offloadThreshold: 1024, // force the offload path without a 100KB print
  });
  assert.equal(r.ok, true);
  assert.equal(r.offloaded, true);
  assert.ok(r.pointer, 'pointer id expected');
  assert.equal(r.output, undefined, 'raw stdout must NOT re-enter context');
  assert.match(r.hint, /eap_search/);
  // Retrieval is lossless: the exact line comes back from the store.
  const hits = store.search('needle-9137', { docId: r.pointer });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].body, /status=500 db timeout/);
  store.close();
});

test('small stdout stays inline even with a store attached', async () => {
  const store = new RuntimeStore(':memory:');
  const r = await executeScript('print("500 requests, 12 errors, avg 34ms")', {
    language: 'python3',
    store,
  });
  assert.equal(r.offloaded, false);
  assert.equal(r.output.trim(), '500 requests, 12 errors, avg 34ms');
  store.close();
});

test('wall-clock timeout kills the child', async () => {
  const r = await executeScript('import time\ntime.sleep(60)', {
    language: 'python3',
    timeoutMs: 500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});

test('huge timeoutMs is clamped, not coerced to 1ms', async () => {
  // Regression (Fix 6): Node's setTimeout silently coerces a delay > 2**31-1 to
  // 1ms, which would SIGKILL even a trivial job before the interpreter starts.
  // The effective timeout is clamped to [1, MAX_TIMEOUT_MS], so a huge request
  // runs to completion instead of timing out.
  const r = await executeScript('print(1)', { language: 'python3', timeoutMs: 2 ** 40 });
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, false);
});

test('output cap truncates runaway stdout and flags it', async () => {
  const r = await executeScript('print("x" * 100000)', {
    language: 'python3',
    maxOutputBytes: 1000,
  });
  assert.equal(r.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(r.output) <= 1000);
});

test('timeout reaps the whole process tree (no orphaned grandchild holds the pipe)', async (t) => {
  // Regression: killing only the direct child leaves a grandchild that
  // inherited the stdout pipe running — it blocks 'close' AND survives as an
  // orphan. The fix runs the child as a process-group leader and SIGKILLs the
  // group. POSIX-only (Windows has no process groups; it uses child.kill).
  if (process.platform === 'win32') { t.skip('POSIX process-group semantics'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eap-tree-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = [
    'import subprocess, sys, time',
    'p = subprocess.Popen(["sleep", "30"], stdout=sys.stdout)',
    `open(${JSON.stringify(pidFile)}, "w").write(str(p.pid))`,
    'sys.stdout.flush()',
    'time.sleep(30)',
  ].join('\n');
  const r = await executeScript(script, { language: 'python3', timeoutMs: 800 });
  assert.equal(r.timedOut, true);
  const gpid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  assert.ok(Number.isInteger(gpid) && gpid > 0, 'grandchild pid recorded');
  // Poll: the grandchild must be gone (SIGKILLed along with its group).
  let alive = true;
  for (let i = 0; i < 30; i++) {
    try { process.kill(gpid, 0); } catch { alive = false; break; }
    await new Promise((res) => setTimeout(res, 100));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(alive, false, 'grandchild survived the timeout — process tree not reaped');
});
