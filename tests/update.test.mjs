// Tests for bin/lib/update.mjs (check / dry-run / ref validation; mocked exec).
// Run: node --test tests/update.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isValidRef,
  parseUpdateArgs,
  resolveCheckout,
  planUpdate,
  compareForCheck,
  runUpdate,
  writeInstallState,
  readInstallState,
  defaultStatePath,
} from '../bin/lib/update.mjs';

const LS_REMOTE = [
  'aaa\trefs/tags/v0.1.0',
  'bbb\trefs/tags/v0.2.0',
  'ccc\trefs/tags/v0.2.0^{}',
  'ddd\trefs/tags/v0.10.1',
].join('\n');

test('isValidRef / parseUpdateArgs: ref validation + flags', () => {
  assert.equal(isValidRef('v0.2.0'), true);
  assert.equal(isValidRef('main'), true);
  assert.equal(isValidRef('feature/x'), true);
  assert.equal(isValidRef('-bad'), false);
  assert.equal(isValidRef('a..b'), false);
  assert.equal(isValidRef(''), false);

  const ok = parseUpdateArgs(['--check', '--ref', 'v0.2.0', '--only', 'claude']);
  assert.equal(ok.check, true);
  assert.equal(ok.ref, 'v0.2.0');
  assert.deepEqual(ok.installArgs, ['--only', 'claude']);

  const bad = parseUpdateArgs(['--ref']);
  assert.equal(bad.error, 'missing-ref');

  const badRef = parseUpdateArgs(['--ref', '../etc/passwd']);
  assert.equal(badRef.error, 'invalid-ref');

  const dry = parseUpdateArgs(['--dry-run', '--force']);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.force, true);
});

test('resolveCheckout: EAP_HOME > ~/.eap/src > repo-root', () => {
  const home = mkdtempSync(join(tmpdir(), 'eap-upd-home-'));
  try {
    const src = join(home, '.eap', 'src');
    mkdirSync(join(src, '.git'), { recursive: true });
    const viaSrc = resolveCheckout({
      env: {},
      home,
      repoRoot: '/tmp/other',
      existsSync: (p) => existsSync(p),
      isEap: () => false,
    });
    assert.equal(viaSrc.root, src);
    assert.equal(viaSrc.source, '~/.eap/src');

    const eapHome = join(home, 'custom');
    mkdirSync(join(eapHome, '.git'), { recursive: true });
    const viaEnv = resolveCheckout({
      env: { EAP_HOME: eapHome },
      home,
      existsSync: (p) => existsSync(p),
    });
    assert.equal(viaEnv.root, eapHome);
    assert.equal(viaEnv.source, 'EAP_HOME');

    const repo = mkdtempSync(join(tmpdir(), 'eap-repo-'));
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'eap-protocol' }));
    const viaRepo = resolveCheckout({
      env: {},
      home: mkdtempSync(join(tmpdir(), 'eap-empty-home-')),
      repoRoot: repo,
      existsSync: (p) => existsSync(p),
      isEap: (p) => p === repo,
    });
    assert.equal(viaRepo.root, repo);
    assert.equal(viaRepo.source, 'repo-root');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('planUpdate: ff-only on branch with upstream', () => {
  const plan = planUpdate({
    root: '/fake',
    head: {
      sha: 'aaa', branch: 'main', detached: false, onTag: false,
      tag: null, upstream: 'origin/main', version: '0.1.0',
    },
    exec: () => { throw new Error('no git'); },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'ff-pull');
  assert.equal(plan.target, 'origin/main');
  assert.ok(plan.steps.some((s) => s.op === 'fetch'));
  assert.ok(plan.steps.some((s) => s.op === 'ff-pull'));
  assert.ok(plan.steps.some((s) => s.op === 'install'));
});

test('planUpdate: detached → latest release tag from ls-remote', () => {
  const plan = planUpdate({
    root: '/fake',
    head: {
      sha: 'aaa', branch: null, detached: true, onTag: true,
      tag: 'v0.1.0', upstream: null, version: '0.1.0',
    },
    lsRemote: () => LS_REMOTE,
    exec: () => { throw new Error('no git'); },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'checkout-tag');
  assert.equal(plan.target, 'v0.10.1');
});

test('planUpdate: --ref tag / --force / invalid ref', () => {
  const head = {
    sha: 'aaa', branch: 'main', detached: false, onTag: false,
    tag: null, upstream: 'origin/main', version: '0.1.0',
  };
  const tagPlan = planUpdate({ root: '/fake', ref: 'v0.2.0', head, exec: () => '' });
  assert.equal(tagPlan.mode, 'checkout-tag');
  assert.ok(tagPlan.steps.some((s) => s.op === 'checkout-tag'));

  const forcePlan = planUpdate({ root: '/fake', ref: 'main', force: true, head, exec: () => '' });
  assert.equal(forcePlan.mode, 'force-reset');
  assert.ok(forcePlan.steps.some((s) => s.op === 'force-reset' && s.hardTo === 'origin/main'));

  const bad = planUpdate({ root: '/fake', ref: 'a..b', head, exec: () => '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid-ref');
});

test('runUpdate --dry-run: plan only, no git mutate / no install', async () => {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args].join(' '));
    // inspectHead probes during planUpdate — answer enough to look like a branch
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'deadbeef\n';
    if (args[0] === 'symbolic-ref') return 'main\n';
    if (args[0] === 'describe') throw new Error('no tag');
    if (args[0] === 'rev-parse' && args.includes('@{upstream}')) return 'origin/main\n';
    throw new Error(`unexpected: ${file} ${args.join(' ')}`);
  };
  const home = mkdtempSync(join(tmpdir(), 'eap-dry-'));
  const root = mkdtempSync(join(tmpdir(), 'eap-dry-repo-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'eap-protocol', version: '0.1.0' }));
  const logs = [];
  try {
    const r = await runUpdate(['--dry-run'], {
      env: { EAP_HOME: root },
      home,
      exec,
      log: (s) => logs.push(s),
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.exitCode, 0);
    assert.ok(logs.some((l) => /dry run/i.test(l)));
    assert.ok(logs.some((l) => /ff-only|merge --ff-only/i.test(l)));
    // No fetch/merge/install executed in dry-run (only inspectHead probes).
    assert.ok(!calls.some((c) => c.includes('fetch')));
    assert.ok(!calls.some((c) => c.includes('merge')));
    assert.ok(!calls.some((c) => c.includes('eap-install')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('runUpdate --check: reports current vs remote, no install', async () => {
  const calls = [];
  const exec = (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaa111\n';
    if (args[0] === 'symbolic-ref') return 'main\n';
    if (args[0] === 'describe') throw new Error('no');
    if (args[0] === 'rev-parse' && args.includes('@{upstream}')) return 'origin/main\n';
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return 'bbb222\n';
    throw new Error(`unexpected: ${key}`);
  };
  const home = mkdtempSync(join(tmpdir(), 'eap-chk-'));
  const root = mkdtempSync(join(tmpdir(), 'eap-chk-repo-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'eap-protocol', version: '0.1.0' }));
  const logs = [];
  try {
    const r = await runUpdate(['--check'], {
      env: { EAP_HOME: root },
      home,
      exec,
      log: (s) => logs.push(s),
    });
    assert.equal(r.ok, true);
    assert.equal(r.check, true);
    assert.equal(r.status, 'behind-or-diverged');
    assert.equal(r.current.sha, 'aaa111');
    assert.equal(r.remote.sha, 'bbb222');
    assert.ok(calls.some((c) => c.includes('fetch --tags')));
    assert.ok(!calls.some((c) => c.includes('merge')));
    assert.ok(!calls.some((c) => c.includes('eap-install')));
    assert.ok(logs.some((l) => /status:\s+behind-or-diverged/.test(l)));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('runUpdate rejects invalid --ref before touching git', async () => {
  let execCalls = 0;
  const r = await runUpdate(['--ref', 'a..b'], {
    exec: () => { execCalls++; return ''; },
    log: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid-ref');
  assert.equal(r.exitCode, 2);
  assert.equal(execCalls, 0);
});

test('writeInstallState / readInstallState round-trip', () => {
  const home = mkdtempSync(join(tmpdir(), 'eap-state-'));
  try {
    const state = writeInstallState({
      root: '/opt/eap',
      sha: 'abc123',
      home,
      now: () => '2026-07-14T00:00:00.000Z',
    });
    assert.equal(state.sha, 'abc123');
    const path = defaultStatePath(home);
    assert.ok(existsSync(path));
    const read = readInstallState(home);
    assert.deepEqual(read, {
      root: '/opt/eap',
      sha: 'abc123',
      updatedAt: '2026-07-14T00:00:00.000Z',
    });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).sha, 'abc123');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('compareForCheck uses latest tag when detached', () => {
  const r = compareForCheck({
    root: '/fake',
    head: {
      sha: 'aaa', branch: null, detached: true, onTag: true,
      tag: 'v0.1.0', upstream: null, version: '0.1.0',
    },
    lsRemote: () => LS_REMOTE,
    exec: (file, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'v0.10.1') return 'ddd\n';
      throw new Error(`unexpected ${args.join(' ')}`);
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.remote.ref, 'v0.10.1');
  assert.equal(r.status, 'behind-or-diverged');
});
