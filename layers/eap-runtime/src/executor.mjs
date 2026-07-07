// EAP-Runtime — "think in code" executor (clean-room, spec-only implementation).
//
// Implements move 1 of layers/eap-runtime/DESIGN.md: the agent writes a short
// script; we run it in a child subprocess against data on disk, and ONLY the
// script's printed stdout re-enters context. Oversized stdout is passed through
// the store's offload() so context receives a searchable pointer, not raw bytes.
//
// Security posture (stated honestly, per DESIGN.md): the network deny-list below
// is a POLICY control, not a sandbox. The child inherits host credentials and is
// not OS-isolated. Real isolation is an explicit later layer.
//
// Zero third-party dependencies: node:child_process, node:fs, node:os,
// node:path, node:crypto only.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Languages the executor shells out to. It uses runtimes already on the host;
// it does not bundle them (DESIGN.md "Runtime & dependencies").
const INTERPRETERS = {
  python3: { cmd: 'python3', ext: '.py' },
  python: { cmd: 'python3', ext: '.py' },
  node: { cmd: 'node', ext: '.mjs' },
  javascript: { cmd: 'node', ext: '.mjs' },
  js: { cmd: 'node', ext: '.mjs' },
  bash: { cmd: 'bash', ext: '.sh' },
  sh: { cmd: 'bash', ext: '.sh' },
};

export const SUPPORTED_LANGUAGES = Object.keys(INTERPRETERS);

// POLICY network deny-list (DESIGN.md "Security"): scripts that shell out to
// network CLIs or make inline HTTP calls are refused before anything is
// spawned, and the agent is redirected to the allowlisted eap_fetch path.
// This is a source-text policy check — deterministic and unit-testable with
// no network involved.
const NETWORK_DENY_RULES = [
  { re: /\bcurl\b/, label: 'curl' },
  { re: /\bwget\b/, label: 'wget' },
  { re: /\bnc\b/, label: 'nc' },
  { re: /\bfetch\(\s*['"`]https?:/, label: "fetch('http…')" },
  { re: /\brequests\.(get|post|put|patch|delete|head|request)\b/, label: 'requests.*' },
  { re: /\burllib\.request\b/, label: 'urllib.request' },
  { re: /\bhttp\.client\b/, label: 'http.client' },
  { re: /\bnet\.connect\b/, label: 'net.connect' },
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

// Run a script "in code". Dependency-injected (store, thresholds, injected
// createdAt — no clock reads in the offload path) so it is unit-testable
// without any real network.
//
// Returns one of:
//   { ok:false, error:'network-denied'|'unsupported-language'|'spawn-failed', message }
//   { ok, exitCode, signal, timedOut, stdoutBytes, stdoutTruncated,
//     stderr, stderrTruncated, offloaded:false, output }
//   { ...same head..., offloaded:true, pointer, hint }
export async function executeScript(script, {
  language = 'python3',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  store = null,
  offloadThreshold = undefined,
  createdAt = 0,
  cwd = undefined,
} = {}) {
  const src = String(script ?? '');

  // Clamp the caller-supplied timeout to a sane [1, MAX_TIMEOUT_MS] range before
  // it ever reaches setTimeout. The default param above is untouched; only the
  // value actually used is clamped. Non-finite (NaN/Infinity) falls back to the
  // default.
  const t = Number(timeoutMs);
  const effectiveTimeout = Number.isFinite(t)
    ? Math.min(Math.max(1, Math.floor(t)), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  const interp = INTERPRETERS[String(language).toLowerCase()];
  if (!interp) {
    return {
      ok: false,
      error: 'unsupported-language',
      message: `Unsupported language "${language}". Supported: ${SUPPORTED_LANGUAGES.join(', ')}.`,
    };
  }

  const policy = checkNetworkPolicy(src);
  if (!policy.allowed) {
    return {
      ok: false,
      error: 'network-denied',
      message: `Refused by network policy: script matches denied pattern "${policy.match}". ` +
        'eap_execute has no network egress. Use eap_fetch instead — it retrieves the URL ' +
        'through the host allowlist, indexes the body, and returns a searchable pointer.',
    };
  }

  // Write the script under a fresh mkdtemp dir; the child also runs there by
  // default so stray files it creates are swept up with the dir.
  const dir = mkdtempSync(join(tmpdir(), 'eap-exec-'));
  const file = join(dir, 'script' + interp.ext);
  try {
    writeFileSync(file, src);
    const run = await runChild(interp.cmd, [file], {
      timeoutMs: effectiveTimeout,
      maxOutputBytes,
      cwd: cwd ?? dir,
    });

    if (run.spawnError) {
      return {
        ok: false,
        error: 'spawn-failed',
        message: `Failed to start ${interp.cmd}: ${run.spawnError}`,
      };
    }

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

    if (store) {
      // Deterministic source label from the script hash, so identical scripts
      // dedupe in the store.
      const tag = createHash('sha256').update(src).digest('hex').slice(0, 12);
      const off = store.offload(`eap_execute:${interp.cmd}:${tag}`, stdout, {
        threshold: offloadThreshold,
        createdAt,
      });
      if (!off.inline) {
        return { ...base, offloaded: true, pointer: off.pointer, hint: off.hint };
      }
      return { ...base, offloaded: false, output: off.body };
    }
    return { ...base, offloaded: false, output: stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
