// EAP — graceful self-update (stdlib only).
//
// Resolves the EAP git checkout, fetches from GitHub, fast-forwards or checks
// out a pinned release tag, records ~/.eap/install-state.json, then re-runs
// the installer so hooks / Signal / Lean / skills / MCP stay in sync.
//
// CLI `eap update` is explicit operator consent to apply. MCP eap_upgrade stays
// plan-only when no checksum manifest exists (see layers/eap-runtime/src/upgrade.mjs).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isReleaseTag,
  latestReleaseTag,
  parseLsRemoteTags,
  resolveReleaseTag,
} from '../../layers/eap-runtime/src/upgrade.mjs';

export const CLONE_URL = 'https://github.com/0p9b/EAP.git';
export const REMOTE = 'origin';

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/;

export function expandHome(p, home = os.homedir()) {
  return String(p).replace(/^\$HOME\b/, home).replace(/^~(?=$|[/\\])/, home);
}

export function defaultSrcDir(home = os.homedir()) {
  return path.join(home, '.eap', 'src');
}

export function defaultStatePath(home = os.homedir()) {
  return path.join(home, '.eap', 'install-state.json');
}

export function isValidRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-') && REF_RE.test(ref)
    && !ref.includes('..') && !ref.includes('@{');
}

function defaultExec(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    cwd: opts.cwd,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

export function readPackageName(root, { readFileSync: read = fs.readFileSync } = {}) {
  try {
    return JSON.parse(read(path.join(root, 'package.json'), 'utf8')).name ?? null;
  } catch { return null; }
}

export function isEapCheckout(root, {
  existsSync = fs.existsSync,
  readFileSync: read = fs.readFileSync,
  exec = defaultExec,
} = {}) {
  if (!root || !existsSync(path.join(root, 'package.json'))) return false;
  if (readPackageName(root, { readFileSync: read }) === 'eap-protocol') return true;
  try {
    const remotes = exec('git', ['remote', '-v'], { cwd: root });
    return /0p9b\/EAP(\.git)?\b/i.test(remotes);
  } catch { return false; }
}

/** Resolve where the EAP git checkout lives (or should be cloned). */
export function resolveCheckout({
  env = process.env,
  home = os.homedir(),
  repoRoot = null,
  existsSync = fs.existsSync,
  isGitDir = (p) => existsSync(path.join(p, '.git')),
  isEap = isEapCheckout,
} = {}) {
  if (env.EAP_HOME) {
    const root = path.resolve(expandHome(env.EAP_HOME, home));
    return { root, source: 'EAP_HOME', exists: existsSync(root) && isGitDir(root) };
  }
  const src = defaultSrcDir(home);
  if (existsSync(src) && isGitDir(src)) {
    return { root: src, source: '~/.eap/src', exists: true };
  }
  if (repoRoot) {
    const root = path.resolve(repoRoot);
    if (isGitDir(root) && isEap(root)) {
      return { root, source: 'repo-root', exists: true };
    }
  }
  return { root: src, source: 'default', exists: false };
}

export function readInstallState(home = os.homedir(), {
  statePath = defaultStatePath(home),
  readFileSync: read = fs.readFileSync,
  existsSync = fs.existsSync,
} = {}) {
  if (!existsSync(statePath)) return null;
  try { return JSON.parse(read(statePath, 'utf8')); }
  catch { return null; }
}

export function writeInstallState({
  root,
  sha = null,
  home = os.homedir(),
  statePath = defaultStatePath(home),
  now = () => new Date().toISOString(),
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  const dir = path.dirname(statePath);
  mkdirSync(dir, { recursive: true });
  const state = {
    root: path.resolve(root),
    sha: sha || null,
    updatedAt: typeof now === 'function' ? now() : now,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

export function parseUpdateArgs(argv) {
  const opts = {
    help: false,
    check: false,
    dryRun: false,
    force: false,
    ref: null,
    installArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '--check': opts.check = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '--ref': {
        const v = argv[++i];
        if (!v || v.startsWith('-')) {
          return { error: 'missing-ref', message: 'error: --ref requires a tag or branch name' };
        }
        if (!isValidRef(v)) {
          return { error: 'invalid-ref', message: `error: invalid --ref "${v}"` };
        }
        opts.ref = v;
        break;
      }
      case '--':
        opts.installArgs.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        // Pass unrecognized flags through to the installer re-run.
        if (a.startsWith('-')) {
          if (a.includes('=') || ['--only', '--config-dir', '--with-mcp-shrink'].includes(a)) {
            opts.installArgs.push(a);
            if (!a.includes('=') && ['--only', '--config-dir', '--with-mcp-shrink'].includes(a)) {
              const v = argv[++i];
              if (v) opts.installArgs.push(v);
            }
          } else {
            opts.installArgs.push(a);
          }
        } else {
          return { error: 'unknown-arg', message: `error: unexpected argument: ${a}\nrun 'eap update --help'` };
        }
    }
  }
  return opts;
}

function git(exec, root, args, opts = {}) {
  return exec('git', args, { cwd: root, ...opts });
}

function gitOk(exec, root, args) {
  try { git(exec, root, args); return true; }
  catch { return false; }
}

function gitOut(exec, root, args) {
  try { return String(git(exec, root, args)).trim(); }
  catch { return ''; }
}

export function inspectHead(root, { exec = defaultExec } = {}) {
  const sha = gitOut(exec, root, ['rev-parse', 'HEAD']);
  const branch = gitOut(exec, root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const detached = !branch;
  const exactTag = gitOut(exec, root, ['describe', '--exact-match', '--tags', 'HEAD']);
  const upstream = branch
    ? gitOut(exec, root, ['rev-parse', '--abbrev-ref', '@{upstream}'])
    : '';
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null;
  } catch { /* */ }
  return {
    sha,
    branch: branch || null,
    detached,
    onTag: Boolean(exactTag),
    tag: exactTag || null,
    upstream: upstream || null,
    version,
  };
}

function lsRemoteTags(exec, root, remote = REMOTE) {
  return git(exec, root, ['ls-remote', '--tags', remote], { timeout: 30_000 });
}

/**
 * Build an update plan. Pure aside from injected exec / lsRemote for git probes.
 * Does not mutate the working tree.
 */
export function planUpdate({
  root,
  ref = null,
  force = false,
  remote = REMOTE,
  exec = defaultExec,
  lsRemote = null,
  head = null,
} = {}) {
  const h = head || inspectHead(root, { exec });
  const steps = [];
  steps.push({ op: 'fetch', argv: ['fetch', '--tags', remote], label: `git fetch --tags ${remote}` });

  let target = null;
  let mode = null;

  if (ref) {
    if (!isValidRef(ref)) {
      return { ok: false, error: 'invalid-ref', message: `invalid --ref "${ref}"` };
    }
    target = ref;
    if (force) {
      mode = 'force-reset';
      const hardTo = isReleaseTag(ref) ? ref : `${remote}/${ref}`;
      steps.push({
        op: 'force-reset',
        argv: ['checkout', '-f', ref],
        argv2: ['reset', '--hard', hardTo],
        label: `git checkout -f ${ref} && git reset --hard ${hardTo}`,
        ref,
        hardTo,
      });
    } else if (isReleaseTag(ref)) {
      mode = 'checkout-tag';
      steps.push({ op: 'checkout-tag', argv: ['checkout', '--detach', ref], label: `git checkout --detach ${ref}`, ref });
    } else {
      mode = 'checkout-branch';
      steps.push({
        op: 'checkout-branch',
        argv: ['checkout', ref],
        argv2: ['merge', '--ff-only', `${remote}/${ref}`],
        label: `git checkout ${ref} && git merge --ff-only ${remote}/${ref}`,
        ref,
      });
    }
  } else if (h.branch && h.upstream) {
    target = h.upstream;
    if (force) {
      mode = 'force-reset';
      steps.push({
        op: 'force-reset',
        argv: ['reset', '--hard', h.upstream],
        label: `git reset --hard ${h.upstream}`,
        hardTo: h.upstream,
      });
    } else {
      mode = 'ff-pull';
      steps.push({
        op: 'ff-pull',
        argv: ['merge', '--ff-only', h.upstream],
        label: `git merge --ff-only ${h.upstream}`,
        upstream: h.upstream,
      });
    }
  } else if (h.detached || h.onTag || !h.branch) {
    const resolved = resolveReleaseTag(null, {
      lsRemote: lsRemote || (() => lsRemoteTags(exec, root, remote)),
      remote,
    });
    if (resolved.error) {
      return { ok: false, ...resolved, head: h };
    }
    target = resolved.tag;
    mode = force ? 'force-reset' : 'checkout-tag';
    if (force) {
      steps.push({
        op: 'force-reset',
        argv: ['checkout', '-f', '--detach', target],
        argv2: ['reset', '--hard', target],
        label: `git checkout -f --detach ${target} && git reset --hard ${target}`,
        ref: target,
        hardTo: target,
      });
    } else {
      steps.push({
        op: 'checkout-tag',
        argv: ['checkout', '--detach', target],
        label: `git checkout --detach ${target}`,
        ref: target,
      });
    }
  } else {
    return {
      ok: false,
      error: 'no-upstream',
      message: `branch "${h.branch}" has no upstream; pass --ref <tag|branch> or set upstream`,
      head: h,
    };
  }

  steps.push({
    op: 'install',
    label: 'node bin/eap-install.mjs --non-interactive',
  });
  steps.push({ op: 'write-state', label: 'record ~/.eap/install-state.json' });

  return {
    ok: true,
    root,
    head: h,
    target,
    mode,
    force: Boolean(force),
    steps,
  };
}

export function compareForCheck({
  root,
  ref = null,
  remote = REMOTE,
  exec = defaultExec,
  lsRemote = null,
  head = null,
} = {}) {
  const h = head || inspectHead(root, { exec });
  let remoteLabel = null;
  let remoteSha = null;
  let status = 'unknown';

  if (ref) {
    remoteLabel = ref;
    remoteSha = gitOut(exec, root, ['rev-parse', `${remote}/${ref}`])
      || gitOut(exec, root, ['rev-parse', ref]);
  } else if (h.upstream) {
    remoteLabel = h.upstream;
    remoteSha = gitOut(exec, root, ['rev-parse', h.upstream]);
  } else {
    const resolved = resolveReleaseTag(null, {
      lsRemote: lsRemote || (() => lsRemoteTags(exec, root, remote)),
      remote,
    });
    if (resolved.error) return { ok: false, ...resolved, head: h };
    remoteLabel = resolved.tag;
    remoteSha = gitOut(exec, root, ['rev-parse', resolved.tag])
      || (() => {
        const out = lsRemote ? lsRemote(remote) : lsRemoteTags(exec, root, remote);
        const line = String(out).split('\n').find((l) => l.includes(`refs/tags/${resolved.tag}`));
        return line ? line.trim().split(/\s+/)[0] : null;
      })();
  }

  if (h.sha && remoteSha && h.sha === remoteSha) status = 'up-to-date';
  else if (h.sha && remoteSha) status = 'behind-or-diverged';
  else status = 'unknown';

  return {
    ok: true,
    status,
    current: { sha: h.sha, branch: h.branch, tag: h.tag, version: h.version, detached: h.detached },
    remote: { ref: remoteLabel, sha: remoteSha },
  };
}

function ensureCheckout({
  checkout,
  cloneUrl = CLONE_URL,
  dryRun = false,
  exec = defaultExec,
  mkdirSync = fs.mkdirSync,
  log = () => {},
} = {}) {
  if (checkout.exists) return { ok: true, root: checkout.root, cloned: false };
  if (dryRun) {
    log(`would clone ${cloneUrl} → ${checkout.root}`);
    return { ok: true, root: checkout.root, cloned: false, plannedClone: true };
  }
  mkdirSync(path.dirname(checkout.root), { recursive: true });
  log(`cloning ${cloneUrl} → ${checkout.root}`);
  try {
    exec('git', ['clone', '--tags', cloneUrl, checkout.root], { timeout: 120_000 });
  } catch (e) {
    return { ok: false, error: 'clone-failed', message: `git clone failed: ${e.message}` };
  }
  return { ok: true, root: checkout.root, cloned: true };
}

function runGitStep(step, { root, exec }) {
  git(exec, root, step.argv);
  if (step.argv2) git(exec, root, step.argv2);
}

function runInstaller({
  root,
  installBin,
  nodePath = process.execPath,
  installArgs = [],
  exec = defaultExec,
  dryRun = false,
  log = () => {},
} = {}) {
  const bin = installBin || path.join(root, 'bin', 'eap-install.mjs');
  const args = [bin, '--non-interactive', ...installArgs];
  const label = `node ${path.relative(root, bin) || 'bin/eap-install.mjs'} --non-interactive${installArgs.length ? ' ' + installArgs.join(' ') : ''}`;
  if (dryRun) {
    log(`would run: ${label}`);
    return { ok: true, dryRun: true };
  }
  log(label);
  try {
    exec(nodePath, args, { cwd: root, timeout: 300_000, stdio: 'inherit' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'install-failed', message: e.message || String(e) };
  }
}

/**
 * Full update flow. Returns a result object; exit codes are for the CLI wrapper.
 */
export async function runUpdate(argv = [], {
  env = process.env,
  home = os.homedir(),
  repoRoot = null,
  installBin = null,
  nodePath = process.execPath,
  cloneUrl = CLONE_URL,
  remote = REMOTE,
  exec = defaultExec,
  lsRemote = null,
  existsSync = fs.existsSync,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
  readFileSync: read = fs.readFileSync,
  statePath = null,
  now = () => new Date().toISOString(),
  log = (s) => process.stdout.write(s + '\n'),
  warn = (s) => process.stderr.write(s + '\n'),
} = {}) {
  const parsed = parseUpdateArgs(argv);
  if (parsed.error) return { ok: false, ...parsed, exitCode: 2 };
  if (parsed.help) {
    log(UPDATE_HELP);
    return { ok: true, help: true, exitCode: 0 };
  }

  const checkout = resolveCheckout({
    env, home, repoRoot, existsSync,
    isEap: (p) => isEapCheckout(p, { existsSync, readFileSync: read, exec }),
  });

  const ensured = ensureCheckout({
    checkout,
    cloneUrl,
    dryRun: parsed.dryRun || parsed.check,
    exec,
    mkdirSync,
    log,
  });
  if (!ensured.ok) return { ...ensured, exitCode: 1 };
  if (ensured.plannedClone && parsed.check) {
    return {
      ok: true,
      check: true,
      status: 'missing',
      message: `no checkout at ${checkout.root}; would clone ${cloneUrl}`,
      exitCode: 0,
    };
  }
  const root = ensured.root;

  if (parsed.check) {
    // Fetch first so remote-tracking refs are current (no checkout/install).
    if (!parsed.dryRun) {
      try { git(exec, root, ['fetch', '--tags', remote]); }
      catch (e) { return { ok: false, error: 'fetch-failed', message: e.message, exitCode: 1 }; }
    }
    const cmp = compareForCheck({
      root,
      ref: parsed.ref,
      remote,
      exec,
      lsRemote: lsRemote || ((r) => lsRemoteTags(exec, root, r)),
    });
    if (!cmp.ok) return { ...cmp, exitCode: 1 };
    log(`current: ${cmp.current.sha || '?'}${cmp.current.branch ? ` (${cmp.current.branch})` : cmp.current.tag ? ` (tag ${cmp.current.tag})` : ''}${cmp.current.version ? ` v${cmp.current.version}` : ''}`);
    log(`remote:  ${cmp.remote.sha || '?'}${cmp.remote.ref ? ` (${cmp.remote.ref})` : ''}`);
    log(`status:  ${cmp.status}`);
    return { ok: true, check: true, ...cmp, exitCode: 0 };
  }

  const plan = planUpdate({
    root,
    ref: parsed.ref,
    force: parsed.force,
    remote,
    exec,
    lsRemote: lsRemote || ((r) => lsRemoteTags(exec, root, r)),
  });
  if (!plan.ok) return { ...plan, exitCode: 1 };

  if (parsed.dryRun) {
    log('eap update — dry run (no changes)');
    log(`  checkout: ${root}`);
    log(`  current:  ${plan.head.sha || '?'}${plan.head.branch ? ` branch=${plan.head.branch}` : plan.head.tag ? ` tag=${plan.head.tag}` : ' detached'}`);
    log(`  target:   ${plan.target} (${plan.mode}${plan.force ? ', force' : ''})`);
    for (const s of plan.steps) log(`  • ${s.label}`);
    if (parsed.installArgs.length) log(`  install extras: ${parsed.installArgs.join(' ')}`);
    return { ok: true, dryRun: true, plan, exitCode: 0 };
  }

  log(`eap update — ${root}`);
  for (const step of plan.steps) {
    if (step.op === 'install') {
      const ir = runInstaller({
        root,
        installBin: installBin || path.join(root, 'bin', 'eap-install.mjs'),
        nodePath,
        installArgs: parsed.installArgs,
        exec,
        log,
      });
      if (!ir.ok) return { ...ir, exitCode: 1 };
      continue;
    }
    if (step.op === 'write-state') {
      const sha = gitOut(exec, root, ['rev-parse', 'HEAD']);
      const state = writeInstallState({
        root, sha, home, statePath: statePath || defaultStatePath(home), now,
        mkdirSync, writeFileSync,
      });
      log(`  recorded ${statePath || defaultStatePath(home)} (sha ${state.sha})`);
      continue;
    }
    try {
      log(`  ${step.label}`);
      runGitStep(step, { root, exec });
    } catch (e) {
      const msg = e.stderr || e.message || String(e);
      warn(`update failed at ${step.op}: ${msg}`);
      if (step.op === 'ff-pull') {
        warn('hint: local commits diverge; re-run with --force --ref <branch> (discards local commits) or rebase manually');
      }
      return { ok: false, error: 'git-failed', step: step.op, message: String(msg), exitCode: 1 };
    }
  }

  log('eap update done');
  return { ok: true, applied: true, root, target: plan.target, mode: plan.mode, exitCode: 0 };
}

const UPDATE_HELP = `eap update — fetch upstream EAP, refresh checkout, re-run installer.

USAGE
  eap update [options] [-- installer-flags...]
  node bin/eap-install.mjs update [options]

OPTIONS
  --check           Report current vs remote; fetch only, no checkout/install.
  --dry-run         Print the update plan; write nothing.
  --ref <tag|branch>
                    Explicit target (release tag or branch). Required for --force
                    against a non-default target.
  --force           Hard-reset to origin/<ref> (or the resolved tag). Explicit only.
  -h, --help        Show this help.

After a successful git update, runs:
  node bin/eap-install.mjs --non-interactive [installer-flags...]

Checkout resolution: $EAP_HOME, else ~/.eap/src, else this repo if it is an
EAP git checkout. Missing checkout → clone ${CLONE_URL} to ~/.eap/src.

Install state is recorded in ~/.eap/install-state.json (root, sha, updatedAt).

MCP eap_upgrade stays plan-only without checksums; this CLI applies because you
typed \`eap update\`.
`;

export function printUpdateHelp(log = (s) => process.stdout.write(s + '\n')) {
  log(UPDATE_HELP);
}

/** CLI entry used by bin/eap.mjs and `eap-install update`. */
export async function runUpdateCli(argv, opts = {}) {
  const r = await runUpdate(argv, opts);
  return r.exitCode ?? (r.ok ? 0 : 1);
}

// Re-export upgrade helpers useful to callers/tests.
export { isReleaseTag, latestReleaseTag, parseLsRemoteTags, resolveReleaseTag };

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runUpdateCli(process.argv.slice(2), {
    repoRoot: path.resolve(path.dirname(__filename), '..', '..'),
    installBin: path.resolve(path.dirname(__filename), '..', 'eap-install.mjs'),
  }).then((code) => process.exit(code));
}
