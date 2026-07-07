// Regression tests for the interactive installer TUI.
// Hermetic: uses `--only claude` so the roster is deterministic (no dependence
// on which agents happen to be installed on the test machine).
// Run: node --test tests/tui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(HERE, '..', 'bin', 'eap-install.mjs');

function runTui(stdin, args) {
  return spawnSync(process.execPath, [INSTALLER, '--tui', '--no-color', '--only', 'claude', ...args], {
    input: stdin, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('--tui drives from stdin, shows the plan, and dry-run writes nothing', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'eap-tui-'));
  const before = fs.readdirSync(cfg).length;
  // Runtime Y, Context Y, Proceed Y.
  const r = runTui('y\ny\ny\n', ['--dry-run', '--config-dir', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Targets \(from --only\)/);
  assert.match(r.stdout, /Plan:.*Claude Code/);
  assert.match(r.stdout, /Plan:.*Voice \+ Runtime \+ Context/);
  assert.equal(fs.readdirSync(cfg).length, before, 'dry-run TUI wrote files');
  fs.rmSync(cfg, { recursive: true, force: true });
});

test('--tui with "n" at Proceed cancels cleanly and writes nothing', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'eap-tui-'));
  const r = runTui('y\ny\nn\n', ['--config-dir', cfg]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Cancelled/);
  assert.equal(fs.readdirSync(cfg).length, 0, 'cancelled TUI wrote files');
  fs.rmSync(cfg, { recursive: true, force: true });
});

test('--tui + --yes skips the confirm; declining layers yields Voice-only', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'eap-tui-'));
  // Runtime n, Context n; --yes means no Proceed prompt.
  const r = runTui('n\nn\n', ['--yes', '--dry-run', '--config-dir', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan:.*layers: Voice$/m);
  assert.doesNotMatch(r.stdout, /Plan:.*Runtime/);
  fs.rmSync(cfg, { recursive: true, force: true });
});
