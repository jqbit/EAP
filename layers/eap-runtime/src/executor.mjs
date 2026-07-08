// EAP-Runtime — "think in code" executor (clean-room, spec-only implementation).
//
// Implements move 1 of layers/eap-runtime/DESIGN.md: the agent writes a short
// script; we run it in a child subprocess against data on disk, and ONLY the
// script's printed stdout re-enters context. Oversized stdout is passed through
// the store's offload() so context receives a searchable pointer, not raw bytes.
// When the caller supplies an `intent`, an offloaded result also carries the
// intent-matching chunks plus a searchable vocabulary (intent-driven filtering).
//
// Polyglot: python3/node/bash plus ruby, go, rust, php, perl, r, elixir,
// typescript and csharp — each shelling out to a runtime already on the host.
// Missing runtimes yield a clean "runtime-not-available" result, never a crash.
//
// Security posture (stated honestly, per DESIGN.md): the network deny-list below
// is a POLICY control, not a sandbox. The child inherits host credentials and is
// not OS-isolated. Real isolation is an explicit later layer.
//
// Zero third-party dependencies: node:child_process, node:fs, node:os,
// node:path, node:crypto only.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_TIMEOUT_MS = 30_000;
// Hard upper bound on the effective wall-clock timeout. A caller-supplied
// timeoutMs is clamped to this: values > 2**31-1 are silently coerced by Node's
// setTimeout to 1ms (killing legit jobs), and multi-day values would disable the
// only hard bound and head-of-line-block the single-threaded serve() queue.
export const MAX_TIMEOUT_MS = 300_000;
// Hard per-stream capture cap: anything beyond this is dropped (flagged as
// truncated). This bounds executor memory; the *offload* threshold below it
// decides pointer-vs-inline for what was captured.
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// After a timeout SIGKILL, a grandchild that inherited the stdout/stderr pipe
// can keep the parent's 'close' from firing. We wait this long, then tear the
// pipes down and resolve as timed-out regardless, so the executor never hangs
// past its timeout.
export const TIMEOUT_GRACE_MS = 500;
// Upper bound on scripts per eap_batch_execute call.
export const MAX_BATCH = 20;

// Language table. Each entry lists the candidate interpreter binaries to detect
// (first found wins), the temp-file extension, and how to build the run (and,
// for compiled languages, the compile) argv from the resolved binary + file.
// The executor uses runtimes already on the host; it does not bundle them
// (DESIGN.md "Runtime & dependencies").
const LANGS = {
  python3: { ext: '.py', detect: ['python3', 'python'], run: (b, f) => [b, [f]] },
  node: { ext: '.mjs', detect: ['node'], run: (b, f) => [b, [f]] },
  bash: { ext: '.sh', detect: ['bash'], run: (b, f) => [b, [f]] },
  ruby: { ext: '.rb', detect: ['ruby'], run: (b, f) => [b, [f]] },
  go: { ext: '.go', detect: ['go'], run: (b, f) => [b, ['run', f]] },
  rust: {
    ext: '.rs', detect: ['rustc'],
    compile: (b, f, dir) => [b, [f, '-o', join(dir, 'eap_rust_bin'), '--edition', '2021']],
    run: (_b, _f, dir) => [join(dir, 'eap_rust_bin'), []],
  },
  php: { ext: '.php', detect: ['php'], run: (b, f) => [b, [f]] },
  perl: { ext: '.pl', detect: ['perl'], run: (b, f) => [b, [f]] },
  r: { ext: '.R', detect: ['Rscript'], run: (b, f) => [b, [f]] },
  elixir: { ext: '.exs', detect: ['elixir'], run: (b, f) => [b, [f]] },
  typescript: {
    ext: '.ts', detect: ['tsx', 'deno', 'node'],
    run: (b, f) => {
      const base = basename(b);
      if (base === 'deno' || base === 'deno.exe') return [b, ['run', '--quiet', f]];
      if (base === 'tsx' || base === 'tsx.exe') return [b, [f]];
      return [b, ['--no-warnings', '--experimental-strip-types', f]]; // node
    },
  },
  csharp: { ext: '.csx', detect: ['dotnet'], run: (b, f) => [b, ['script', f]] },
};

// Friendly aliases mapping to canonical language keys.
const ALIASES = {
  python: 'python3', py: 'python3',
  javascript: 'node', js: 'node', mjs: 'node',
  sh: 'bash', shell: 'bash',
  rb: 'ruby',
  golang: 'go',
  rs: 'rust',
  pl: 'perl',
  rscript: 'r',
  ex: 'elixir', exs: 'elixir',
  ts: 'typescript', tsx: 'typescript',
  cs: 'csharp', 'c#': 'csharp', dotnet: 'csharp',
};

// Extension -> canonical language (for eap_execute_file inference).
const EXT_LANG = {
  '.py': 'python3', '.mjs': 'node', '.js': 'node', '.cjs': 'node', '.sh': 'bash',
  '.bash': 'bash', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.php': 'php',
  '.pl': 'perl', '.pm': 'perl', '.r': 'r', '.exs': 'elixir', '.ts': 'typescript',
  '.csx': 'csharp',
};

export const SUPPORTED_LANGUAGES = [...Object.keys(LANGS), ...Object.keys(ALIASES)];
export const CANONICAL_LANGUAGES = Object.keys(LANGS);

// PATH lookup (no spawn): find the first executable named `cmd`. Cached per
// process. Handles win32 PATHEXT and absolute/relative paths.
const PATHEXT = process.platform === 'win32'
  ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
  : [''];
const whichCache = new Map();
export function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  let found = null;
  if (cmd.includes('/') || cmd.includes('\\')) {
    if (existsSync(cmd)) found = cmd;
  } else {
    const sep = process.platform === 'win32' ? ';' : ':';
    outer: for (const d of (process.env.PATH || '').split(sep)) {
      if (!d) continue;
      for (const ext of PATHEXT) {
        const p = join(d, cmd + ext);
        try { if (statSync(p).isFile()) { found = p; break outer; } } catch { /* keep looking */ }
      }
    }
  }
  whichCache.set(cmd, found);
  return found;
}

// Resolve a language name to a concrete runtime, or an error descriptor:
//   { key, def, bin }
//   { error: 'unsupported-language' }
//   { error: 'runtime-not-available', language, tried }
export function resolveInterpreter(language) {
  const key = ALIASES[String(language).toLowerCase()] ?? String(language).toLowerCase();
  const def = LANGS[key];
  if (!def) return { error: 'unsupported-language', key };
  for (const c of def.detect) {
    const bin = which(c);
    if (bin) return { key, def, bin };
  }
  return { error: 'runtime-not-available', language: key, tried: def.detect };
}

// A report of which languages have a runtime on this host (for eap_doctor).
export function runtimeAvailability() {
  const out = {};
  for (const [key, def] of Object.entries(LANGS)) {
    let path = null;
    for (const c of def.detect) { path = which(c); if (path) break; }
    out[key] = { available: !!path, path, tried: def.detect };
  }
  return out;
}

// POLICY network deny-list (DESIGN.md "Security"): scripts that shell out to
// network CLIs or make inline network calls are refused before anything is
// spawned, and the agent is redirected to the allowlisted eap_fetch path. This
// is a source-text policy check — deterministic, language-agnostic, and
// unit-testable with no network involved.
const NETWORK_DENY_RULES = [
  { re: /\bcurl\b/, label: 'curl' },
  { re: /\bwget\b/, label: 'wget' },
  { re: /\bnc\b/, label: 'nc' },
  { re: /\bfetch\(\s*['"`]https?:/, label: "fetch('http…')" },
  { re: /\brequests\.(get|post|put|patch|delete|head|request)\b/, label: 'requests.*' },
  { re: /\burllib\.request\b/, label: 'urllib.request' },
  { re: /\bhttp\.client\b/, label: 'http.client' },
  { re: /\bnet\.connect\b/, label: 'net.connect' },
  // Additional language-specific idioms so the deny-list applies polyglot-wide.
  { re: /\bNet::HTTP\b/, label: 'Net::HTTP (ruby)' },
  { re: /\bopen-uri\b|\bURI\.open\b/, label: 'open-uri (ruby)' },
  { re: /\bhttp\.(Get|Post|Head|NewRequest|Client)\b/, label: 'net/http (go)' },
  { re: /\bnet\.Dial\b/, label: 'net.Dial (go)' },
  { re: /\bfile_get_contents\s*\(\s*['"]https?:/, label: 'file_get_contents(http…) (php)' },
  { re: /\bcurl_(init|exec)\b/, label: 'curl_* (php)' },
  { re: /\bfsockopen\b/, label: 'fsockopen (php)' },
  { re: /\bLWP\b|\bIO::Socket\b/, label: 'LWP/IO::Socket (perl)' },
  { re: /\bHttpClient\b|\bWebClient\b/, label: 'HttpClient/WebClient (csharp)' },
  { re: /\bsocket\.connect\b/, label: 'socket.connect' },
  // bash/sh built-in TCP/UDP pseudo-devices — full egress with no external binary.
  { re: /\/dev\/(?:tcp|udp)\//, label: '/dev/tcp (bash)' },
  // node core network modules loaded via require()/import()/static import — the
  // bare `net.connect` rule above misses the `require('net').connect(...)` chain.
  { re: /\b(?:require|import)\(\s*['"](?:node:)?(?:net|http|https|http2|dgram|tls)['"]\s*\)/, label: 'require/import(net/http/…) (node)' },
  { re: /\bfrom\s+['"](?:node:)?(?:net|http|https|http2|dgram|tls)['"]/, label: "from 'net/http/…' (node)" },
  { re: /\bhttps?\.(?:get|request)\b/, label: 'http.get/request (node)' },
  // R
  { re: /\bdownload\.file\s*\(/, label: 'download.file (r)' },
  { re: /\burl\s*\(\s*['"]https?:/, label: 'url("http…") (r)' },
  { re: /\bhttr\b|\bRCurl\b|\bcurl(?:GET|POST|PerformGet)\b/, label: 'httr/RCurl (r)' },
  // elixir / erlang
  { re: /:httpc\b|:gen_tcp\b|:gen_udp\b|:ssl\.connect\b/, label: ':httpc/:gen_tcp (elixir)' },
  { re: /\bHTTPoison\b|\bFinch\b|\bTesla\b|\bReq\.(?:get|post|request)\b/, label: 'HTTPoison/Finch/Req (elixir)' },
];

// Pure policy check: given script source, allow or name the matched rule.
export function checkNetworkPolicy(source) {
  const src = String(source ?? '');
  for (const rule of NETWORK_DENY_RULES) {
    if (rule.re.test(src)) return { allowed: false, match: rule.label };
  }
  return { allowed: true, match: null };
}

// Spawn `cmd args` and collect stdout/stderr with a wall-clock timeout and a
// per-stream byte cap. Never rejects; always resolves to a plain result object.
function runChild(cmd, args, { timeoutMs, maxOutputBytes, cwd }) {
  return new Promise((resolve) => {
    // detached => the child leads its own process group, so on timeout we can
    // SIGKILL the whole group (child + grandchildren) with a negative pid.
    // Windows has no POSIX process groups, so we skip detached there.
    const groupKill = process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: groupKill,
    });
    const out = { buf: [], bytes: 0, truncated: false };
    const err = { buf: [], bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let graceTimer = null;
    const decode = (state) => Buffer.concat(state.buf).toString('utf8');
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };
    const killTree = () => {
      // Kill the whole group so a grandchild holding the stdout pipe dies too;
      // fall back to killing just the child (win32, or if the group is gone).
      if (groupKill && child.pid != null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch { /* group already gone — fall through */ }
      }
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // If 'close' does not arrive (a surviving grandchild is holding the
      // pipe open), tear the pipes down and resolve as timed-out anyway.
      graceTimer = setTimeout(() => {
        try { child.stdout?.destroy(); } catch { /* noop */ }
        try { child.stderr?.destroy(); } catch { /* noop */ }
        finish({
          exitCode: child.exitCode,
          signal: 'SIGKILL',
          timedOut: true,
          stdout: decode(out),
          stdoutTruncated: out.truncated,
          stderr: decode(err),
          stderrTruncated: err.truncated,
        });
      }, TIMEOUT_GRACE_MS);
      if (graceTimer.unref) graceTimer.unref();
    }, timeoutMs);
    const sink = (state) => (chunk) => {
      if (state.truncated) return;
      const room = maxOutputBytes - state.bytes;
      if (chunk.length > room) {
        if (room > 0) state.buf.push(chunk.subarray(0, room));
        state.bytes = maxOutputBytes;
        state.truncated = true;
      } else {
        state.buf.push(chunk);
        state.bytes += chunk.length;
      }
    };
    child.stdout.on('data', sink(out));
    child.stderr.on('data', sink(err));
    child.on('error', (e) => finish({ spawnError: e.message }));
    child.on('close', (code, signal) => finish({
      exitCode: code,
      signal,
      timedOut,
      stdout: decode(out),
      stdoutTruncated: out.truncated,
      stderr: decode(err),
      stderrTruncated: err.truncated,
    }));
  });
}

// Clamp a caller-supplied timeout into [1, MAX_TIMEOUT_MS]. Non-finite falls
// back to the default. See the "huge timeoutMs" regression test.
function clampTimeout(timeoutMs) {
  const t = Number(timeoutMs);
  return Number.isFinite(t)
    ? Math.min(Math.max(1, Math.floor(t)), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

// Turn a completed child run + the resolved head fields into the public result,
// routing large stdout through the store (offload / intent filtering).
function finalize(run, { store, sourceLabel, offloadThreshold, createdAt, intent }) {
  const stdout = run.stdout ?? '';
  const base = {
    ok: run.exitCode === 0 && !run.timedOut,
    exitCode: run.exitCode,
    signal: run.signal ?? null,
    timedOut: run.timedOut,
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutTruncated: run.stdoutTruncated,
    stderr: run.stderr ?? '',
    stderrTruncated: run.stderrTruncated,
  };
  if (!store) return { ...base, offloaded: false, output: stdout };

  const off = store.offload(sourceLabel, stdout, { threshold: offloadThreshold, createdAt });
  if (off.inline) return { ...base, offloaded: false, output: off.body };

  const result = { ...base, offloaded: true, pointer: off.pointer, hint: off.hint };
  // Intent-driven filtering: instead of a bare pointer, return the chunks that
  // match the caller's stated intent plus a searchable vocabulary of terms.
  const want = intent != null && String(intent).trim();
  if (want) {
    const q = String(intent).trim();
    const matches = store.search(q, { docId: off.pointer, limit: 5 });
    const vocabulary = store.vocabulary(off.pointer, { limit: 15 });
    result.intent = q;
    result.matches = matches;
    result.vocabulary = vocabulary;
    result.hint = `Indexed under ${off.pointer} (${off.bytes} bytes kept out of context). ` +
      `Returning ${matches.length} chunk(s) matching intent "${q}". ` +
      `Search the full document with eap_search(query, { docId: "${off.pointer}" }). ` +
      (vocabulary.length ? `Searchable terms: ${vocabulary.slice(0, 10).join(', ')}.` : '');
  }
  return result;
}

// Shared runner: given a resolved interpreter, a written file, and its temp dir,
// compile (if needed) and run, then finalize. Never throws.
async function runResolved(resolved, file, dir, {
  timeoutMs, maxOutputBytes, cwd, store, sourceLabel, offloadThreshold, createdAt, intent,
}) {
  const { def, bin } = resolved;
  const effectiveTimeout = clampTimeout(timeoutMs);

  if (def.compile) {
    const [ccmd, cargs] = def.compile(bin, file, dir);
    const compiled = await runChild(ccmd, cargs, {
      timeoutMs: effectiveTimeout, maxOutputBytes, cwd: cwd ?? dir,
    });
    if (compiled.spawnError) {
      return { ok: false, error: 'spawn-failed', message: `Failed to start ${ccmd}: ${compiled.spawnError}` };
    }
    if (compiled.exitCode !== 0 || compiled.timedOut) {
      return {
        ok: false, error: 'compile-failed',
        message: `${resolved.key} compilation failed (exit ${compiled.exitCode}).`,
        stderr: compiled.stderr ?? '', timedOut: compiled.timedOut,
      };
    }
  }

  const [rcmd, rargs] = def.run(bin, file, dir);
  const run = await runChild(rcmd, rargs, {
    timeoutMs: effectiveTimeout, maxOutputBytes, cwd: cwd ?? dir,
  });
  if (run.spawnError) {
    return { ok: false, error: 'spawn-failed', message: `Failed to start ${rcmd}: ${run.spawnError}` };
  }
  return finalize(run, { store, sourceLabel, offloadThreshold, createdAt, intent });
}

// Run a script "in code". Dependency-injected (store, thresholds, injected
// createdAt — no clock reads in the offload path) so it is unit-testable
// without any real network.
//
// Returns one of:
//   { ok:false, error:'network-denied'|'unsupported-language'|'runtime-not-available'|'spawn-failed'|'compile-failed', message }
//   { ok, exitCode, signal, timedOut, stdoutBytes, stdoutTruncated, stderr,
//     stderrTruncated, offloaded:false, output }
//   { ...same head..., offloaded:true, pointer, hint }
//   { ...same head..., offloaded:true, pointer, hint, intent, matches, vocabulary }
export async function executeScript(script, {
  language = 'python3',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  store = null,
  offloadThreshold = undefined,
  createdAt = 0,
  cwd = undefined,
  intent = undefined,
} = {}) {
  const src = String(script ?? '');

  const resolved = resolveInterpreter(language);
  if (resolved.error === 'unsupported-language') {
    return {
      ok: false, error: 'unsupported-language',
      message: `Unsupported language "${language}". Supported: ${CANONICAL_LANGUAGES.join(', ')}.`,
    };
  }
  if (resolved.error === 'runtime-not-available') {
    return {
      ok: false, error: 'runtime-not-available', language: resolved.language,
      message: `Runtime for "${resolved.language}" is not installed on this host (looked for: ` +
        `${resolved.tried.join(', ')}). Install it or choose another language.`,
    };
  }

  const policy = checkNetworkPolicy(src);
  if (!policy.allowed) {
    return {
      ok: false, error: 'network-denied',
      message: `Refused by network policy: script matches denied pattern "${policy.match}". ` +
        'eap_execute has no network egress. Use eap_fetch instead — it retrieves the URL ' +
        'through the SSRF-hardened allowlist, indexes the body, and returns a searchable pointer.',
    };
  }

  // Write the script under a fresh mkdtemp dir; the child also runs there by
  // default so stray files it creates are swept up with the dir.
  const dir = mkdtempSync(join(tmpdir(), 'eap-exec-'));
  const file = join(dir, 'script' + resolved.def.ext);
  const tag = createHash('sha256').update(src).digest('hex').slice(0, 12);
  try {
    writeFileSync(file, src);
    return await runResolved(resolved, file, dir, {
      timeoutMs, maxOutputBytes, cwd, store,
      sourceLabel: `eap_execute:${resolved.key}:${tag}`,
      offloadThreshold, createdAt, intent,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Run an existing script file from disk (eap_execute_file). Language is inferred
// from the extension unless given. The file itself is executed in place (cwd =
// its directory) so it can read sibling data. The same network policy applies.
export async function executeFile(path, {
  language = undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  store = null,
  offloadThreshold = undefined,
  createdAt = 0,
  cwd = undefined,
  intent = undefined,
} = {}) {
  const p = String(path ?? '');
  if (!p) return { ok: false, error: 'bad-path', message: 'eap_execute_file requires a file path.' };
  let st;
  try { st = statSync(p); } catch { return { ok: false, error: 'not-found', message: `No such file: ${p}` }; }
  if (!st.isFile()) return { ok: false, error: 'not-a-file', message: `Not a regular file: ${p}` };

  const lang = language ?? EXT_LANG[extname(p).toLowerCase()];
  if (!lang) {
    return {
      ok: false, error: 'unsupported-language',
      message: `Cannot infer language for "${p}". Pass language explicitly. Supported: ${CANONICAL_LANGUAGES.join(', ')}.`,
    };
  }
  const resolved = resolveInterpreter(lang);
  if (resolved.error === 'unsupported-language') {
    return { ok: false, error: 'unsupported-language', message: `Unsupported language "${lang}". Supported: ${CANONICAL_LANGUAGES.join(', ')}.` };
  }
  if (resolved.error === 'runtime-not-available') {
    return {
      ok: false, error: 'runtime-not-available', language: resolved.language,
      message: `Runtime for "${resolved.language}" is not installed on this host (looked for: ${resolved.tried.join(', ')}).`,
    };
  }

  // Fail closed: if we cannot read the file, we cannot apply the network
  // policy, so we must NOT run it (a leftover empty src would let the scan pass
  // and the file execute anyway — fail-open).
  let src;
  try {
    src = readFileSync(p, 'utf8');
  } catch {
    return {
      ok: false, error: 'policy-scan-failed',
      message: 'Cannot read file to apply network policy; refusing to execute.',
    };
  }
  const policy = checkNetworkPolicy(src);
  if (!policy.allowed) {
    return {
      ok: false, error: 'network-denied',
      message: `Refused by network policy: file matches denied pattern "${policy.match}". Use eap_fetch for URLs.`,
    };
  }

  const tag = createHash('sha256').update(p).digest('hex').slice(0, 12);
  // Compiled languages need an output dir; run others directly against the file.
  const dir = dirname(p);
  return runResolved(resolved, p, dir, {
    timeoutMs, maxOutputBytes, cwd: cwd ?? dir, store,
    sourceLabel: `eap_execute_file:${basename(p)}:${tag}`,
    offloadThreshold, createdAt, intent,
  });
}

// Run several scripts, bounded (eap_batch_execute). Sequential so resource use
// stays predictable. Rejects batches larger than MAX_BATCH. Each item:
//   { script, language?, timeoutMs?, intent? }
export async function executeBatch(items, {
  maxItems = MAX_BATCH,
  store = null,
  offloadThreshold = undefined,
  createdAt = 0,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  if (!Array.isArray(items)) {
    return { ok: false, error: 'bad-batch', message: 'eap_batch_execute requires an array of scripts.' };
  }
  if (items.length === 0) {
    return { ok: false, error: 'empty-batch', message: 'eap_batch_execute needs at least one script.' };
  }
  if (items.length > maxItems) {
    return { ok: false, error: 'batch-too-large', message: `Batch of ${items.length} exceeds the limit of ${maxItems}.` };
  }
  const results = [];
  for (const item of items) {
    const it = item && typeof item === 'object' ? item : {};
    // eslint-disable-next-line no-await-in-loop -- bounded & intentionally serial
    const r = await executeScript(it.script ?? '', {
      language: it.language ?? 'python3',
      timeoutMs: it.timeoutMs,
      intent: it.intent,
      maxOutputBytes,
      store, offloadThreshold, createdAt,
    });
    results.push(r);
  }
  return { ok: results.every((r) => r.ok), count: results.length, results };
}
