// Tests for the EAP unified installer (bin/eap-install.mjs).
// Run: node --test tests/installer.test.mjs
//
// Shells out to the real CLI so the tests exercise the same code path a user
// hits, then asserts on the files the install landed in a throwaway config dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'eap-install.mjs');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });
}
function mkTmp(tag) { return mkdtempSync(join(tmpdir(), `eap-${tag}-`)); }

test('--list exits 0 and prints the provider matrix (claude end-to-end)', () => {
  const r = run(['--list', '--no-color']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /provider matrix/i);
  assert.match(r.stdout, /claude/);
  assert.match(r.stdout, /end-to-end/);
  assert.match(r.stdout, /planned/);
  // The full 35-provider roster is present.
  assert.match(r.stdout, /antigravity/);
});

test('--help exits 0 and documents the flags', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--no-runtime/);
  assert.match(r.stdout, /--no-context/);
  assert.match(r.stdout, /--uninstall/);
});

test('--dry-run --only claude writes NOTHING and plans Voice + both MCP + hooks', () => {
  const dir = mkTmp('dry');
  try {
    const r = run(['--dry-run', '--only', 'claude', '--config-dir', dir, '--non-interactive', '--no-color']);
    assert.equal(r.status, 0, r.stderr);
    // Plan mentions all three layers.
    assert.match(r.stdout, /Voice/);
    assert.match(r.stdout, /eap-runtime/);
    assert.match(r.stdout, /eap-context/);
    assert.match(r.stdout, /SessionStart/);
    assert.match(r.stdout, /PostToolUse/);
    // Nothing was written into the config dir.
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'CLAUDE.md must not be written on dry-run');
    assert.ok(!existsSync(join(dir, 'settings.json')), 'settings.json must not be written on dry-run');
    assert.ok(!existsSync(join(dir, '.mcp.json')), '.mcp.json must not be written on dry-run');
    assert.ok(!existsSync(join(dir, '.eap.json')), '.eap.json must not be written on dry-run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real --only claude install lands Voice block + both MCP entries + hooks, then uninstall reverses it while preserving user content', () => {
  const dir = mkTmp('inst');
  try {
    // Seed pre-existing user content that MUST survive install + uninstall.
    writeFileSync(join(dir, 'CLAUDE.md'), '# My project rules\nKEEP-THIS-LINE\n');
    writeFileSync(join(dir, 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo USER-HOOK' }] }] } }, null, 2));

    const r = run(['--only', 'claude', '--config-dir', dir, '--non-interactive', '--no-color']);
    assert.equal(r.status, 0, r.stderr);

    // 1. Voice block.
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(md, /<!-- eap-voice:begin -->/);
    assert.match(md, /<!-- eap-voice:end -->/);
    assert.match(md, /Prime directive/);          // real EAP-VOICE.md content
    assert.match(md, /KEEP-THIS-LINE/);            // user content preserved

    // 2. Both MCP servers in .mcp.json (config-dir pinned -> file mechanism).
    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers['eap-runtime'], 'eap-runtime registered');
    assert.ok(mcp.mcpServers['eap-context'], 'eap-context registered');
    assert.equal(mcp.mcpServers['eap-runtime'].command, 'node');
    assert.match(mcp.mcpServers['eap-runtime'].args[0], /layers\/eap-runtime\/src\/mcp\.mjs$/);
    assert.equal(mcp.mcpServers['eap-context'].command, 'python3');
    assert.match(mcp.mcpServers['eap-context'].args[0], /eap_context\/mcp\.py$/);

    // 3. Hooks wired for all four lifecycle events.
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    for (const ev of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreCompact']) {
      assert.ok(settings.hooks[ev], `hook event ${ev} present`);
    }
    const dump = JSON.stringify(settings);
    assert.match(dump, /eap-dispatch/);
    assert.match(dump, /USER-HOOK/);               // user hook preserved alongside ours

    // Layer-flags file for the dispatcher.
    const flags = JSON.parse(readFileSync(join(dir, '.eap.json'), 'utf8'));
    assert.equal(flags.runtime, true);
    assert.equal(flags.context, true);

    // ── uninstall ──
    const u = run(['--uninstall', '--config-dir', dir, '--non-interactive', '--no-color']);
    assert.equal(u.status, 0, u.stderr);

    const md2 = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.doesNotMatch(md2, /eap-voice:begin/);   // block stripped
    assert.match(md2, /KEEP-THIS-LINE/);           // user content still there

    const settings2 = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(settings2), /eap-dispatch/);   // our hooks gone
    assert.match(JSON.stringify(settings2), /USER-HOOK/);             // user hook survives

    const mcp2 = existsSync(join(dir, '.mcp.json'))
      ? JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) : { mcpServers: {} };
    assert.ok(!(mcp2.mcpServers && mcp2.mcpServers['eap-runtime']), 'eap-runtime removed');
    assert.ok(!(mcp2.mcpServers && mcp2.mcpServers['eap-context']), 'eap-context removed');

    assert.ok(!existsSync(join(dir, '.eap.json')), '.eap.json removed on uninstall');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--no-runtime / --no-context each independently drop their MCP server', () => {
  const dir = mkTmp('opt');
  try {
    run(['--only', 'claude', '--config-dir', dir, '--non-interactive', '--no-color', '--no-context']);
    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers['eap-runtime'], 'runtime still registered');
    assert.ok(!mcp.mcpServers['eap-context'], 'context skipped via --no-context');
    const flags = JSON.parse(readFileSync(join(dir, '.eap.json'), 'utf8'));
    assert.equal(flags.context, false);
    assert.equal(flags.runtime, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown --only id is rejected with exit 2', () => {
  const r = run(['--only', 'not-a-real-agent', '--non-interactive']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown agent/);
});

test('a planted CLAUDE.md symlink is not followed (atomic write, symlink-safe)', () => {
  const home = mkTmp('symhome');
  const outside = mkTmp('symout');
  try {
    const target = join(outside, 'secret.txt');
    writeFileSync(target, 'ORIGINAL SECRET\n');
    const cfgDir = join(home, '.claude');
    mkdirSync(cfgDir, { recursive: true });
    symlinkSync(target, join(cfgDir, 'CLAUDE.md'));

    const r = run(['--only', 'claude', '--config-dir', cfgDir, '--no-runtime', '--no-context', '--non-interactive'],
      { env: { ...process.env, HOME: home, NO_COLOR: '1' } });
    assert.notEqual(r.status, 2, r.stderr);

    // The out-of-tree target must be untouched (symlink NOT followed)...
    assert.equal(readFileSync(target, 'utf8').trim(), 'ORIGINAL SECRET');
    // ...and CLAUDE.md must now be a real file with the Voice block.
    assert.equal(lstatSync(join(cfgDir, 'CLAUDE.md')).isSymbolicLink(), false);
    assert.match(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), /eap-voice:begin/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
