// Tests for the EAP-Runtime "think in code" executor.
// Run: node --test tests/executor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeScript, executeFile, executeBatch, checkNetworkPolicy,
  resolveInterpreter, runtimeAvailability, CANONICAL_LANGUAGES,
} from '../layers/eap-runtime/src/executor.mjs';
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

test('a genuinely unknown language is refused with a clear message', async () => {
  const r = await executeScript('NOP', { language: 'malbolge' });
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

// ── polyglot: new languages (available ones run; missing ones fail cleanly) ──

test('perl runs when available; only stdout returns', async (t) => {
  if (!resolveInterpreter('perl').bin) { t.skip('perl not installed on this host'); return; }
  const r = await executeScript('print 6 * 7, "\\n";', { language: 'perl' });
  assert.equal(r.ok, true);
  assert.equal(r.output.trim(), '42');
});

test('typescript runs when a TS runtime (tsx/deno/node) is available', async (t) => {
  if (!resolveInterpreter('typescript').bin) { t.skip('no TS runtime (tsx/deno/node strip-types) on this host'); return; }
  const r = await executeScript('const n: number = 20;\nconsole.log(n + 1);', { language: 'typescript' });
  assert.equal(r.ok, true, `stderr: ${r.stderr}`);
  assert.equal(r.output.trim(), '21');
});

test('each newly-supported language is either runnable or fails cleanly with runtime-not-available', async () => {
  // Never a crash, never "unsupported-language" — these ARE supported; they may
  // just lack a host runtime. Records which were skip-gracefully on this box.
  const langs = ['ruby', 'go', 'rust', 'php', 'perl', 'r', 'elixir', 'typescript', 'csharp'];
  for (const lang of langs) {
    const r = await executeScript('print("noop")', { language: lang });
    if (r.error === 'runtime-not-available') {
      assert.equal(r.ok, false);
      assert.match(r.message, /not installed/);
    } else {
      // A runtime exists: it ran (the trivial source may or may not be valid for
      // that language, but it must not be a crash or an unsupported-language).
      assert.notEqual(r.error, 'unsupported-language');
      assert.equal(typeof r.ok, 'boolean');
    }
  }
  // Canonical languages are all recognised (no unsupported-language for these).
  for (const lang of CANONICAL_LANGUAGES) {
    assert.notEqual(resolveInterpreter(lang).error, 'unsupported-language');
  }
});

test('polyglot network deny-list refuses ruby/go/php idioms (pure policy, no runtime)', () => {
  assert.equal(checkNetworkPolicy("require 'net/http'\nNet::HTTP.get(uri)").allowed, false);
  assert.equal(checkNetworkPolicy('resp, _ := http.Get("http://x")').allowed, false);
  assert.equal(checkNetworkPolicy('$x = file_get_contents("http://x");').allowed, false);
  assert.equal(checkNetworkPolicy('$h = curl_init();').allowed, false);
  assert.equal(checkNetworkPolicy('use LWP::UserAgent;').allowed, false);
  // A benign polyglot script is still allowed.
  assert.equal(checkNetworkPolicy('puts [1,2,3].map { |x| x * 2 }').allowed, true);
});

test('deny-list closes bash /dev/tcp, node core-module, R, and elixir egress', () => {
  // bash built-in TCP/UDP pseudo-devices — full egress, no external binary.
  assert.equal(checkNetworkPolicy('exec 3<>/dev/tcp/127.0.0.1/80').allowed, false);
  assert.equal(checkNetworkPolicy('cat </dev/udp/host/53').allowed, false);
  // node core network modules via require()/import()/static import + http.get.
  assert.equal(checkNetworkPolicy("const s = require('net').connect(80,'x')").allowed, false);
  assert.equal(checkNetworkPolicy("const h = require('https'); h.get('http://x')").allowed, false);
  assert.equal(checkNetworkPolicy("import net from 'node:net'").allowed, false);
  assert.equal(checkNetworkPolicy("await import('http')").allowed, false);
  assert.equal(checkNetworkPolicy("http.request({host:'x'})").allowed, false);
  // R
  assert.equal(checkNetworkPolicy('download.file("http://x", "o")').allowed, false);
  assert.equal(checkNetworkPolicy('readLines(url("https://x"))').allowed, false);
  assert.equal(checkNetworkPolicy('library(httr); GET("http://x")').allowed, false);
  // elixir / erlang
  assert.equal(checkNetworkPolicy(':httpc.request(:get, {~c"http://x", []}, [], [])').allowed, false);
  assert.equal(checkNetworkPolicy(':gen_tcp.connect(~c"x", 80, [])').allowed, false);
  assert.equal(checkNetworkPolicy('HTTPoison.get("http://x")').allowed, false);
  // Benign lookalikes stay allowed — no false positives on ordinary code.
  assert.equal(checkNetworkPolicy('const url = "not a call"').allowed, true);
  assert.equal(checkNetworkPolicy('def download_files(x): return x').allowed, true);
  assert.equal(checkNetworkPolicy('cat /dev/null').allowed, true);
});

// ── intent-driven filtering ─────────────────────────────────────────────────

test('offloaded output + intent returns matching chunks and a vocabulary, not a bare pointer', async (t) => {
  if (!resolveInterpreter('python3').bin) { t.skip('python3 missing'); return; }
  const store = new RuntimeStore(':memory:');
  const script = [
    'for i in range(400):',
    '    print(f"routine event {i} status ok metric latency")',
    'print("ALERT breach threshold exceeded on payments service")',
  ].join('\n');
  const r = await executeScript(script, {
    language: 'python3', store, offloadThreshold: 1024, intent: 'breach threshold payments',
  });
  assert.equal(r.offloaded, true);
  assert.ok(r.pointer);
  assert.equal(r.intent, 'breach threshold payments');
  assert.ok(Array.isArray(r.matches) && r.matches.length >= 1, 'intent matches expected');
  assert.match(r.matches[0].body, /breach threshold exceeded/); // lossless chunk
  assert.ok(Array.isArray(r.vocabulary) && r.vocabulary.length > 0, 'vocabulary expected');
  assert.match(r.hint, /matching intent/);
  store.close();
});

// ── eap_execute_file ─────────────────────────────────────────────────────────

test('executeFile runs a script from disk, infers language from extension', async (t) => {
  if (!resolveInterpreter('python3').bin) { t.skip('python3 missing'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eap-file-'));
  const f = path.join(dir, 'job.py');
  fs.writeFileSync(f, 'print("from-file", 3 + 4)');
  const r = await executeFile(f);
  assert.equal(r.ok, true);
  assert.match(r.output, /from-file 7/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('executeFile refuses a missing file and a network-policy-violating file', async () => {
  const miss = await executeFile('/no/such/file.py');
  assert.equal(miss.ok, false);
  assert.equal(miss.error, 'not-found');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eap-file-'));
  const f = path.join(dir, 'bad.sh');
  fs.writeFileSync(f, 'curl http://example.com');
  const denied = await executeFile(f);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'network-denied');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── eap_batch_execute ────────────────────────────────────────────────────────

test('executeBatch runs several scripts sequentially and bounds the count', async (t) => {
  if (!resolveInterpreter('python3').bin) { t.skip('python3 missing'); return; }
  const batch = await executeBatch([
    { script: 'print(1 + 1)', language: 'python3' },
    { script: 'console.log("two")', language: 'node' },
  ]);
  assert.equal(batch.count, 2);
  assert.equal(batch.results[0].output.trim(), '2');
  assert.equal(batch.results[1].output.trim(), 'two');

  const tooBig = await executeBatch(Array.from({ length: 21 }, () => ({ script: 'print(1)' })));
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error, 'batch-too-large');

  const empty = await executeBatch([]);
  assert.equal(empty.error, 'empty-batch');
});

test('runtimeAvailability reports a boolean per canonical language', () => {
  const rep = runtimeAvailability();
  for (const lang of CANONICAL_LANGUAGES) {
    assert.equal(typeof rep[lang].available, 'boolean');
    assert.ok(Array.isArray(rep[lang].tried));
  }
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
