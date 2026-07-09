// Tests for the eap_upgrade safe core (layers/eap-runtime/src/upgrade.mjs).
// Run: node --test tests/upgrade.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleaseTag, parseLsRemoteTags, latestReleaseTag, resolveReleaseTag, upgrade,
} from '../layers/eap-runtime/src/upgrade.mjs';
import { RuntimeStore } from '../layers/eap-runtime/src/store.mjs';
import { createDispatcher } from '../layers/eap-runtime/src/mcp.mjs';

const LS_REMOTE = [
  'aaa\trefs/tags/v0.1.0',
  'bbb\trefs/tags/v0.2.0',
  'ccc\trefs/tags/v0.2.0^{}',
  'ddd\trefs/tags/v0.10.1',   // numeric compare: beats v0.2.0
  'eee\trefs/tags/nightly',   // not a release tag
  'fff\trefs/heads/main',     // not a tag at all
].join('\n');

test('isReleaseTag: pinned release tags only — mutable refs refused', () => {
  assert.equal(isReleaseTag('v1.2.3'), true);
  assert.equal(isReleaseTag('0.2.0'), true);
  assert.equal(isReleaseTag('RELEASE-2026-07'), true);
  for (const bad of ['main', 'master', 'HEAD', 'develop', 'nightly', 'v1.2', '', null]) {
    assert.equal(isReleaseTag(bad), false, `should refuse ${bad}`);
  }
});

test('ls-remote parsing + latest selection (numeric semver, peeled refs dropped)', () => {
  const tags = parseLsRemoteTags(LS_REMOTE);
  assert.ok(tags.includes('v0.2.0') && !tags.includes('v0.2.0^{}'));
  assert.equal(latestReleaseTag(tags), 'v0.10.1');
  assert.equal(latestReleaseTag(['nightly', 'main']), null);
});

test('resolveReleaseTag: explicit tag validated; "main" refused; latest resolved from remote', () => {
  assert.deepEqual(resolveReleaseTag('v0.2.0', {}), { tag: 'v0.2.0', source: 'explicit' });
  assert.equal(resolveReleaseTag('main', {}).error, 'invalid-tag');
  const r = resolveReleaseTag(null, { lsRemote: () => LS_REMOTE });
  assert.deepEqual(r, { tag: 'v0.10.1', source: 'latest-remote' });
  assert.equal(resolveReleaseTag(null, { lsRemote: () => { throw new Error('offline'); } }).error, 'ls-remote-failed');
});

test('upgrade safe core: plan only (applied:false), store migrate + doctor run, no unverified apply', async () => {
  const store = new RuntimeStore(':memory:');
  try {
    const r = await upgrade({
      tag: null,
      store,
      doctor: async () => ({ ok: true, probe: 'DOCTOR-RAN' }),
      lsRemote: () => LS_REMOTE,
      version: '0.1.0',
    });
    assert.equal(r.ok, true);
    assert.equal(r.applied, false); // never fetches/executes code
    assert.equal(r.currentVersion, '0.1.0');
    assert.equal(r.targetTag, 'v0.10.1');
    assert.equal(r.storeHealth.ok, true);
    assert.equal(r.doctor.probe, 'DOCTOR-RAN');
    assert.match(r.verification, /no checksum manifest/);
    assert.ok(r.plan.some((s) => s.includes('checkout v0.10.1')));
    assert.ok(!r.plan.some((s) => /checkout main/.test(s)));
  } finally { store.close(); }
});

test('eap_upgrade MCP tool is wired and refuses a branch name', async () => {
  const store = new RuntimeStore(':memory:');
  const dispatch = createDispatcher({
    store,
    now: () => 1,
    upgrade: (opts) => upgrade({ ...opts, lsRemote: () => LS_REMOTE, version: '0.1.0' }),
  });
  const call = (args) => dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eap_upgrade', arguments: args } });
  try {
    const ok = (await call({})).result.structuredContent;
    assert.equal(ok.targetTag, 'v0.10.1');
    assert.equal(ok.applied, false);
    assert.ok(ok.doctor && ok.doctor.node); // real eap_doctor re-ran
    const bad = (await call({ tag: 'main' })).result.structuredContent;
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'invalid-tag');
  } finally { store.close(); }
});
