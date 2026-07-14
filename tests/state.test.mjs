// Unit tests for src/hooks/eap-state.mjs (defaults, parseSwitch, matcher).
// Run: node --test tests/state.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDefaultMode, resolveDefault, writeDefaultMode, parseSwitch, parseDeactivate,
  subagentMatcherAllows, readMode, setMode, clearMode, LEVELS,
} from '../src/hooks/eap-state.mjs';

const ENV_KEYS = [
  'EAP_LEAN_DEFAULT_MODE', 'EAP_SIGNAL_DEFAULT_MODE',
  'EAP_SUBAGENT_MATCHER', 'EAP_LEAN_SUBAGENT_MATCHER',
  'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

let tmpHome;
before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eap-state-'));
});
after(() => {
  restoreEnv();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});
beforeEach(() => {
  delete process.env.EAP_LEAN_DEFAULT_MODE;
  delete process.env.EAP_SIGNAL_DEFAULT_MODE;
  delete process.env.EAP_SUBAGENT_MATCHER;
  delete process.env.EAP_LEAN_SUBAGENT_MATCHER;
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, 'xdg-' + Math.random().toString(16).slice(2));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, 'claude-' + Math.random().toString(16).slice(2));
});

test('getDefaultMode / resolveDefault fall back to full', () => {
  assert.equal(getDefaultMode('lean'), 'full');
  assert.equal(resolveDefault('signal'), 'full');
});

test('EAP_LEAN_DEFAULT_MODE env wins', () => {
  process.env.EAP_LEAN_DEFAULT_MODE = 'ultra';
  assert.equal(getDefaultMode('lean'), 'ultra');
  process.env.EAP_LEAN_DEFAULT_MODE = 'review'; // invalid for lean default
  assert.equal(getDefaultMode('lean'), 'full');
});

test('writeDefaultMode persists leanDefaultMode + defaultMode', () => {
  assert.equal(writeDefaultMode('lean', 'lite'), true);
  assert.equal(getDefaultMode('lean'), 'lite');
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'eap', 'config.json'), 'utf8'));
  assert.equal(cfg.leanDefaultMode, 'lite');
  assert.equal(cfg.defaultMode, 'lite');
});

test('project .eap/config.json overrides user config; env wins over both', () => {
  writeDefaultMode('lean', 'lite');
  const proj = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
  fs.mkdirSync(path.join(proj, '.eap'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.eap', 'config.json'), JSON.stringify({ leanDefaultMode: 'ultra' }));
  const prev = process.cwd();
  try {
    process.chdir(proj);
    assert.equal(getDefaultMode('lean'), 'ultra');
    process.env.EAP_LEAN_DEFAULT_MODE = 'off';
    assert.equal(getDefaultMode('lean'), 'off');
  } finally {
    process.chdir(prev);
  }
});

test('readMode uses session flag over default', () => {
  process.env.EAP_LEAN_DEFAULT_MODE = 'ultra';
  assert.equal(readMode('lean'), 'ultra');
  assert.ok(setMode('lean', 'lite'));
  assert.equal(readMode('lean'), 'lite');
  clearMode('lean');
  assert.equal(readMode('lean'), 'ultra');
});

test('parseSwitch + default persist path', () => {
  assert.deepEqual(parseSwitch('/eap lean ultra'), { kind: 'lean', mode: 'ultra' });
  assert.deepEqual(parseSwitch('/eap lean default off'), { kind: 'lean', defaultMode: 'off' });
  assert.deepEqual(parseSwitch('/eap signal'), { kind: 'signal', mode: null });
  assert.equal(parseSwitch('not a switch'), null);
  assert.equal(parseDeactivate('normal mode'), 'both');
  assert.equal(parseDeactivate('add a normal mode toggle'), null);
});

test('subagentMatcherAllows fail-open + case-insensitive', () => {
  assert.equal(subagentMatcherAllows('explore', 'EAP_SUBAGENT_MATCHER'), true);
  process.env.EAP_SUBAGENT_MATCHER = 'general|plan';
  assert.equal(subagentMatcherAllows('general', 'EAP_SUBAGENT_MATCHER'), true);
  assert.equal(subagentMatcherAllows('GENERAL', 'EAP_SUBAGENT_MATCHER'), true);
  assert.equal(subagentMatcherAllows('Explore', 'EAP_SUBAGENT_MATCHER'), false);
  assert.equal(subagentMatcherAllows('', 'EAP_SUBAGENT_MATCHER'), true);
  process.env.EAP_SUBAGENT_MATCHER = '(';
  assert.equal(subagentMatcherAllows('x', 'EAP_SUBAGENT_MATCHER'), true);
});

test('LEVELS cover documented modes', () => {
  assert.ok(LEVELS.lean.includes('off'));
  assert.ok(LEVELS.signal.includes('wenyan-full'));
});
