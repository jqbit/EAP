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

// SAFETY: a module-level sandbox HOME is the DEFAULT env for every run() so no
// test can ever touch the real machine's ~/.codex, ~/.grok, ~/.hermes, etc.
// (the native-provider install/uninstall paths resolve via HOME, not just
// --config-dir). PATH is neutralized so a real agent CLI (claude/codex/grok/
// hermes) is never invoked — CLI-MCP paths take their no-bin/file fallback.
// A single fixed HOME keeps install→uninstall pairs consistent within a test;
// callers that need their own throwaway HOME pass an explicit `env` (it wins).
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'eap-testsandbox-'));
const SANDBOX_ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, 'xdg'),
  HERMES_HOME: join(SANDBOX_HOME, 'hermes'),
  CLAUDE_CONFIG_DIR: join(SANDBOX_HOME, 'claude'),
  PATH: '/usr/bin:/bin',
};
function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: SANDBOX_ENV, ...opts });
}
function mkTmp(tag) { return mkdtempSync(join(tmpdir(), `eap-${tag}-`)); }

test('--list exits 0 and prints the provider matrix (claude end-to-end)', () => {
  const r = run(['--list', '--no-color']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /provider matrix/i);
  assert.match(r.stdout, /claude/);
  assert.match(r.stdout, /end-to-end/);
  assert.match(r.stdout, /planned/);
  // Native EAP-Signal agents render as "signal", not "planned".
  assert.match(r.stdout, /signal/);
  // The full provider roster is present.
  assert.match(r.stdout, /antigravity/);
});

test('--help exits 0 and documents the flags', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--no-runtime/);
  assert.match(r.stdout, /--no-context/);
  assert.match(r.stdout, /--uninstall/);
});

test('--dry-run --only claude writes NOTHING and plans Signal + both MCP + hooks', () => {
  const dir = mkTmp('dry');
  try {
    const r = run(['--dry-run', '--only', 'claude', '--config-dir', dir, '--non-interactive', '--no-color']);
    assert.equal(r.status, 0, r.stderr);
    // Plan mentions all three layers.
    assert.match(r.stdout, /Signal/);
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

test('real --only claude install lands Signal block + both MCP entries + hooks, then uninstall reverses it while preserving user content', () => {
  const dir = mkTmp('inst');
  try {
    // Seed pre-existing user content that MUST survive install + uninstall.
    writeFileSync(join(dir, 'CLAUDE.md'), '# My project rules\nKEEP-THIS-LINE\n');
    writeFileSync(join(dir, 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo USER-HOOK' }] }] } }, null, 2));

    const r = run(['--only', 'claude', '--config-dir', dir, '--non-interactive', '--no-color']);
    assert.equal(r.status, 0, r.stderr);

    // 1. Signal block.
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(md, /<!-- eap-signal:begin -->/);
    assert.match(md, /<!-- eap-signal:end -->/);
    assert.match(md, /Prime directive/);          // real EAP-SIGNAL.md content
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
    assert.doesNotMatch(md2, /eap-signal:begin/);   // block stripped
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
    // ...and CLAUDE.md must now be a real file with the Signal block.
    assert.equal(lstatSync(join(cfgDir, 'CLAUDE.md')).isSymbolicLink(), false);
    assert.match(readFileSync(join(cfgDir, 'CLAUDE.md'), 'utf8'), /eap-signal:begin/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── native EAP-Signal agents ──────────────────────────────────────────────────
// The non-Claude agents whose EAP-Signal rule installs natively into a global
// always-on rules file. Every run is fully env-sandboxed (HOME / XDG_CONFIG_HOME
// / HERMES_HOME / CLAUDE_CONFIG_DIR all point into a throwaway dir) so the real
// user's ~/.codex, ~/.grok, etc. are NEVER touched.
const NATIVE_AGENTS = ['codex', 'opencode', 'pi', 'grok', 'antigravity', 'hermes'];

// Sandbox env for a throwaway HOME. Isolates every path the native resolver uses.
function sandboxEnv(home) {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    HERMES_HOME: join(home, 'hermes'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    // Neutralize PATH to a minimal system path so the tests never shell out to a
    // REAL agent CLI (codex/grok/hermes may be installed on the dev machine).
    // sh + coreutils stay reachable; the agent bins do not, so native MCP
    // registration deterministically takes the "bin absent -> manual note"
    // branch — matching the "can't assume the real CLIs accept these args in a
    // sandbox" contract. Node itself is spawned by absolute path, not via PATH.
    PATH: '/usr/bin:/bin',
    NO_COLOR: '1',
  };
}

// Expected native rules-file path for an agent, given a sandbox env. Mirrors
// resolveNativeSignal() in the installer.
function nativePath(id, env) {
  switch (id) {
    case 'codex':       return join(env.HOME, '.codex', 'AGENTS.md');
    case 'opencode':    return join(env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md');
    case 'pi':          return join(env.HOME, '.pi', 'agent', 'AGENTS.md');
    case 'grok':        return join(env.HOME, '.grok', 'AGENTS.md');
    case 'antigravity': return join(env.HOME, '.gemini', 'config', 'AGENTS.md');
    case 'hermes':      return join(env.HERMES_HOME, 'SOUL.md');
    default: throw new Error(`no native path for ${id}`);
  }
}

for (const id of NATIVE_AGENTS) {
  test(`native EAP-Signal: --only ${id} writes the eap-signal block into its global rules file`, () => {
    const home = mkTmp(`nat-${id}`);
    const env = sandboxEnv(home);
    try {
      const r = run(['--only', id, '--non-interactive', '--no-color'], { env });
      assert.equal(r.status, 0, r.stderr);
      const file = nativePath(id, env);
      assert.ok(existsSync(file), `${id}: rules file written at ${file}`);
      const txt = readFileSync(file, 'utf8');
      assert.match(txt, /<!-- eap-signal:begin -->/, `${id}: begin marker`);
      assert.match(txt, /<!-- eap-signal:end -->/, `${id}: end marker`);
      assert.match(txt, /Prime directive/, `${id}: a real EAP-SIGNAL line`);
      // Reported as installed, not planned.
      assert.match(r.stdout, new RegExp(id));
      assert.doesNotMatch(r.stdout, /PLANNED/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test(`native EAP-Signal: --only ${id} is idempotent (one block, file unchanged on re-run)`, () => {
    const home = mkTmp(`nat-idem-${id}`);
    const env = sandboxEnv(home);
    try {
      assert.equal(run(['--only', id, '--non-interactive', '--no-color'], { env }).status, 0);
      const file = nativePath(id, env);
      const first = readFileSync(file, 'utf8');
      assert.equal(run(['--only', id, '--non-interactive', '--no-color'], { env }).status, 0);
      const second = readFileSync(file, 'utf8');
      assert.equal(second, first, `${id}: file byte-identical after re-install`);
      const begins = second.split('<!-- eap-signal:begin -->').length - 1;
      assert.equal(begins, 1, `${id}: exactly one Signal block`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test(`native EAP-Signal: --uninstall strips ${id}'s block, preserving user content above/below`, () => {
    const home = mkTmp(`nat-uninst-${id}`);
    const env = sandboxEnv(home);
    try {
      // Pre-plant user content ABOVE the block, install, then add user content BELOW.
      const file = nativePath(id, env);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '# ABOVE-USER-LINE\n');
      assert.equal(run(['--only', id, '--non-interactive', '--no-color'], { env }).status, 0);
      writeFileSync(file, readFileSync(file, 'utf8') + '\n# BELOW-USER-LINE\n');
      assert.match(readFileSync(file, 'utf8'), /eap-signal:begin/);

      const u = run(['--uninstall', '--non-interactive', '--no-color'], { env });
      assert.equal(u.status, 0, u.stderr);
      const after = readFileSync(file, 'utf8');
      assert.doesNotMatch(after, /eap-signal:begin/, `${id}: block stripped`);
      assert.doesNotMatch(after, /eap-signal:end/, `${id}: end marker stripped`);
      assert.match(after, /ABOVE-USER-LINE/, `${id}: content above preserved`);
      assert.match(after, /BELOW-USER-LINE/, `${id}: content below preserved`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test(`native EAP-Signal: --dry-run --only ${id} writes nothing`, () => {
    const home = mkTmp(`nat-dry-${id}`);
    const env = sandboxEnv(home);
    try {
      const r = run(['--dry-run', '--only', id, '--non-interactive', '--no-color'], { env });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(nativePath(id, env)), `${id}: nothing written on dry-run`);
      assert.match(r.stdout, /would install/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test('native EAP-Signal: --only cursor writes NO global file, exits 0, prints the per-repo note', () => {
  const home = mkTmp('nat-cursor');
  const env = sandboxEnv(home);
  try {
    const r = run(['--only', 'cursor', '--non-interactive', '--no-color'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /per-repo/i);
    assert.match(r.stdout, /cursor/i);
    // Reported as handled (installed list), not planned.
    assert.doesNotMatch(r.stdout, /PLANNED/);
    // No global AGENTS.md / rules file created anywhere in the sandbox.
    const stray = [
      join(env.HOME, 'AGENTS.md'),
      join(env.HOME, '.cursor', 'AGENTS.md'),
      join(env.XDG_CONFIG_HOME, 'cursor', 'AGENTS.md'),
    ];
    for (const p of stray) assert.ok(!existsSync(p), `cursor must not write global ${p}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── native MCP registration (the 6 MCP-capable native agents) ────────────────
// codex/grok/hermes register via their CLI; cursor/antigravity/opencode register
// into a JSON/JSONC config file. pi has NO MCP and is not covered here. Every run
// is env-sandboxed (throwaway HOME/XDG/HERMES + PATH neutralized so the real
// agent CLIs are never invoked).

// JSON-file agents: resolved file path + top-level key + entry shape.
const JSON_MCP_AGENTS = {
  cursor:      { file: (env) => join(env.HOME, '.cursor', 'mcp.json'),                   key: 'mcpServers', shape: 'command-args' },
  antigravity: { file: (env) => join(env.HOME, '.gemini', 'config', 'mcp_config.json'),  key: 'mcpServers', shape: 'command-args' },
  opencode:    { file: (env) => join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), key: 'mcp',        shape: 'command-array-local' },
};

// Pre-seed an unrelated server (shape-appropriate) that MUST survive install +
// uninstall. opencode additionally carries $schema + a plugin array + a comment
// (JSONC) — all must be preserved through the merge.
function seedText(id, key, shape) {
  const other = shape === 'command-array-local'
    ? { type: 'local', command: ['echo', 'hi'], enabled: true }
    : { command: 'echo', args: ['hi'] };
  const obj = { [key]: { 'other-server': other } };
  if (id === 'opencode') {
    obj.$schema = 'https://opencode.ai/config.json';
    obj.plugin = ['some-plugin'];
    return '// opencode config (JSONC — comment must not break the merge)\n' + JSON.stringify(obj, null, 2) + '\n';
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

for (const [id, spec] of Object.entries(JSON_MCP_AGENTS)) {
  test(`native MCP (json): --only ${id} merges eap-runtime + eap-context (${spec.shape}) into "${spec.key}", preserving existing content`, () => {
    const home = mkTmp(`mcp-${id}`);
    const env = sandboxEnv(home);
    try {
      const file = spec.file(env);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, seedText(id, spec.key, spec.shape));

      const r = run(['--only', id, '--non-interactive', '--no-color'], { env });
      assert.equal(r.status, 0, r.stderr);

      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      const servers = cfg[spec.key];
      assert.ok(servers['eap-runtime'], `${id}: eap-runtime registered`);
      assert.ok(servers['eap-context'], `${id}: eap-context registered`);
      assert.ok(servers['other-server'], `${id}: pre-existing server preserved`);

      if (spec.shape === 'command-array-local') {
        // opencode: single command ARRAY + type:local + enabled:true, no args key.
        assert.equal(servers['eap-runtime'].type, 'local');
        assert.equal(servers['eap-runtime'].enabled, true);
        assert.equal(servers['eap-runtime'].command[0], 'node');
        assert.match(servers['eap-runtime'].command[1], /eap-runtime\/src\/mcp\.mjs$/);
        assert.equal(servers['eap-context'].command[0], 'python3');
        assert.match(servers['eap-context'].command[1], /eap_context\/mcp\.py$/);
        // GLOBAL install: no pinned project-root arg (command is exactly [py, mcp.py]).
        assert.equal(servers['eap-context'].command.length, 2, `${id}: eap-context has no project-root arg`);
        // Sibling keys (JSONC $schema + plugin array) survive the merge.
        assert.equal(cfg.$schema, 'https://opencode.ai/config.json', 'opencode: $schema preserved');
        assert.deepEqual(cfg.plugin, ['some-plugin'], 'opencode: plugin array preserved');
      } else {
        // cursor / antigravity: command STRING + args ARRAY, no type key.
        assert.equal(servers['eap-runtime'].command, 'node');
        assert.match(servers['eap-runtime'].args[0], /eap-runtime\/src\/mcp\.mjs$/);
        assert.equal(servers['eap-context'].command, 'python3');
        assert.match(servers['eap-context'].args[0], /eap_context\/mcp\.py$/);
        // GLOBAL install: no pinned project-root arg (args is exactly [mcp.py]).
        assert.equal(servers['eap-context'].args.length, 1, `${id}: eap-context has no project-root arg`);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test('native MCP (json): --no-runtime and --no-context each drop the matching server (cursor)', () => {
  const home = mkTmp('mcp-opt');
  const env = sandboxEnv(home);
  try {
    const file = join(env.HOME, '.cursor', 'mcp.json');
    run(['--only', 'cursor', '--non-interactive', '--no-color', '--no-runtime'], { env });
    let servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers;
    assert.ok(!servers['eap-runtime'], 'runtime dropped via --no-runtime');
    assert.ok(servers['eap-context'], 'context still registered');

    rmSync(file, { force: true });
    run(['--only', 'cursor', '--non-interactive', '--no-color', '--no-context'], { env });
    servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers;
    assert.ok(servers['eap-runtime'], 'runtime still registered');
    assert.ok(!servers['eap-context'], 'context dropped via --no-context');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('native MCP (json): --dry-run --only cursor prints the planned merge but writes no mcp.json', () => {
  const home = mkTmp('mcp-dry');
  const env = sandboxEnv(home);
  try {
    const r = run(['--dry-run', '--only', 'cursor', '--non-interactive', '--no-color'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mcpServers/);
    assert.match(r.stdout, /eap-runtime/);
    assert.match(r.stdout, /eap-context/);
    assert.ok(!existsSync(join(env.HOME, '.cursor', 'mcp.json')), 'dry-run must not write mcp.json');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('native MCP (json): --uninstall removes only the eap entries, leaving other servers + sibling keys intact', () => {
  const home = mkTmp('mcp-uninst');
  const env = sandboxEnv(home);
  try {
    const file = join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, seedText('opencode', 'mcp', 'command-array-local'));

    assert.equal(run(['--only', 'opencode', '--non-interactive', '--no-color'], { env }).status, 0);
    let cfg = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(cfg.mcp['eap-runtime'] && cfg.mcp['eap-context'], 'eap servers present after install');

    const u = run(['--uninstall', '--non-interactive', '--no-color'], { env });
    assert.equal(u.status, 0, u.stderr);
    cfg = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(!cfg.mcp['eap-runtime'], 'eap-runtime removed');
    assert.ok(!cfg.mcp['eap-context'], 'eap-context removed');
    assert.ok(cfg.mcp['other-server'], 'unrelated server preserved');
    assert.equal(cfg.$schema, 'https://opencode.ai/config.json', '$schema preserved');
    assert.deepEqual(cfg.plugin, ['some-plugin'], 'plugin array preserved');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// CLI agents (codex/grok/hermes). We cannot assume the real CLIs accept these
// exact args in a sandbox, so we exercise the no-bin fallback (PATH neutralized
// -> bin absent) and the dry-run printed command.
const CLI_MCP_AGENTS = { codex: 'dashdash', grok: 'dashdash', hermes: 'hermes' };

for (const [id, flavor] of Object.entries(CLI_MCP_AGENTS)) {
  test(`native MCP (cli): --only ${id} with the bin absent prints a manual note and exits 0 (no crash)`, () => {
    const home = mkTmp(`mcp-cli-${id}`);
    const env = sandboxEnv(home);
    try {
      const r = run(['--only', id, '--non-interactive', '--no-color'], { env });
      assert.equal(r.status, 0, r.stderr);
      // Signal still installed (fs only, PATH-independent).
      assert.match(r.stdout, new RegExp(id));
      // Manual fallback surfaced (bin not on PATH) with the copy-pasteable command.
      assert.match(r.stdout + r.stderr, /register manually|not found on PATH/i);
      assert.match(r.stdout, /mcp add eap-runtime/);
      assert.doesNotMatch(r.stdout, /PLANNED/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test(`native MCP (cli): --dry-run --only ${id} prints the exact registration command`, () => {
    const home = mkTmp(`mcp-cli-dry-${id}`);
    const env = sandboxEnv(home);
    try {
      const r = run(['--dry-run', '--only', id, '--non-interactive', '--no-color'], { env });
      assert.equal(r.status, 0, r.stderr);
      if (flavor === 'hermes') {
        assert.match(r.stdout, new RegExp(`${id} mcp add eap-runtime --command node --args`));
        assert.match(r.stdout, new RegExp(`${id} mcp add eap-context --command python3 --args`));
      } else {
        assert.match(r.stdout, new RegExp(`${id} mcp add eap-runtime -- node `));
        assert.match(r.stdout, new RegExp(`${id} mcp add eap-context -- python3 `));
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test('--only accepts a comma-separated list (codex,opencode) without exiting 2', () => {
  const home = mkTmp('mcp-comma');
  const env = sandboxEnv(home);
  try {
    const r = run(['--only', 'codex,opencode', '--non-interactive', '--no-color'], { env });
    assert.equal(r.status, 0, r.stderr);
    // Both agents were acted on.
    assert.match(r.stdout, /codex/i);
    assert.match(r.stdout, /opencode/i);
    // opencode's MCP config landed (JSON agent, PATH-independent).
    const cfg = JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), 'utf8'));
    assert.ok(cfg.mcp['eap-runtime'] && cfg.mcp['eap-context'], 'opencode eap servers registered');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('--only with only commas/whitespace yields zero ids and exits 2', () => {
  const r = run(['--only', ' , ', '--non-interactive', '--no-color']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /at least one agent id|requires/i);
});

// ── EAP-Lean always-on block (peer of EAP-Signal) ────────────────────────────
// EAP-Lean is the minimal-code-craft rule. It installs as a SECOND managed
// fenced block (<!-- eap-lean:begin --> … <!-- eap-lean:end -->) into the SAME
// rules file EAP-Signal writes, for every native agent, on by default with
// Signal and opt-out via --no-lean. Every run is fully env-sandboxed (throwaway
// HOME/XDG/HERMES + PATH neutralized) so the real machine's ~/.codex etc. are
// NEVER touched. codex stands in for the native-agent path (nativePath()).
const LEAN_BEGIN = '<!-- eap-lean:begin -->';
const LEAN_END = '<!-- eap-lean:end -->';
const SIGNAL_BEGIN = '<!-- eap-signal:begin -->';

test('EAP-Lean: --only codex installs BOTH the eap-signal and eap-lean blocks into the native rules file', () => {
  const home = mkTmp('lean-codex');
  const env = sandboxEnv(home);
  try {
    const r = run(['--only', 'codex', '--non-interactive', '--no-color'], { env });
    assert.equal(r.status, 0, r.stderr);
    const file = nativePath('codex', env);
    const txt = readFileSync(file, 'utf8');
    // Both disciplines land in the one rules file.
    assert.match(txt, /<!-- eap-signal:begin -->/, 'signal block present');
    assert.match(txt, /<!-- eap-lean:begin -->/, 'lean block present');
    assert.match(txt, /<!-- eap-lean:end -->/, 'lean end marker present');
    assert.match(txt, /Prime directive/, 'real EAP-SIGNAL content');
    assert.match(txt, /Decision ladder/, 'real EAP-LEAN content');    // the 7-rung ladder
    assert.match(txt, /YAGNI/, 'ladder rung 1');
    // Reported as installed, mentions Lean, never PLANNED.
    assert.match(r.stdout, /Lean/);
    assert.doesNotMatch(r.stdout, /PLANNED/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('EAP-Lean: the eap-lean block is idempotent (exactly one block, file byte-identical on re-run)', () => {
  const home = mkTmp('lean-idem');
  const env = sandboxEnv(home);
  try {
    assert.equal(run(['--only', 'codex', '--non-interactive', '--no-color'], { env }).status, 0);
    const file = nativePath('codex', env);
    const first = readFileSync(file, 'utf8');
    assert.equal(run(['--only', 'codex', '--non-interactive', '--no-color'], { env }).status, 0);
    const second = readFileSync(file, 'utf8');
    assert.equal(second, first, 'file byte-identical after re-install');
    assert.equal(second.split(LEAN_BEGIN).length - 1, 1, 'exactly one eap-lean block');
    assert.equal(second.split(SIGNAL_BEGIN).length - 1, 1, 'exactly one eap-signal block');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('EAP-Lean: --uninstall strips the eap-lean block, preserving user content above/below', () => {
  const home = mkTmp('lean-uninst');
  const env = sandboxEnv(home);
  try {
    const file = nativePath('codex', env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# ABOVE-USER-LINE\n');
    assert.equal(run(['--only', 'codex', '--non-interactive', '--no-color'], { env }).status, 0);
    writeFileSync(file, readFileSync(file, 'utf8') + '\n# BELOW-USER-LINE\n');
    assert.match(readFileSync(file, 'utf8'), /eap-lean:begin/, 'setup: lean block installed');

    const u = run(['--uninstall', '--non-interactive', '--no-color'], { env });
    assert.equal(u.status, 0, u.stderr);
    const after = readFileSync(file, 'utf8');
    assert.doesNotMatch(after, /eap-lean:begin/, 'lean block stripped');
    assert.doesNotMatch(after, /eap-lean:end/, 'lean end marker stripped');
    assert.doesNotMatch(after, /eap-signal:begin/, 'signal block stripped too');
    assert.match(after, /ABOVE-USER-LINE/, 'user content above preserved');
    assert.match(after, /BELOW-USER-LINE/, 'user content below preserved');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('EAP-Lean: --no-lean installs Signal but NOT the eap-lean block', () => {
  const home = mkTmp('lean-off');
  const env = sandboxEnv(home);
  try {
    const r = run(['--only', 'codex', '--no-lean', '--non-interactive', '--no-color'], { env });
    assert.equal(r.status, 0, r.stderr);
    const txt = readFileSync(nativePath('codex', env), 'utf8');
    assert.match(txt, /eap-signal:begin/, 'signal still installed with --no-lean');
    assert.doesNotMatch(txt, /eap-lean:begin/, '--no-lean must skip the lean block');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('EAP-Lean: --dry-run --only codex plans BOTH the Signal and Lean blocks and writes nothing', () => {
  const home = mkTmp('lean-dry');
  const env = sandboxEnv(home);
  try {
    const r = run(['--dry-run', '--only', 'codex', '--non-interactive', '--no-color'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /eap-signal:begin/, 'dry-run plans the Signal block');
    assert.match(r.stdout, /eap-lean:begin/, 'dry-run plans the Lean block');
    assert.match(r.stdout, /would install/);
    assert.ok(!existsSync(nativePath('codex', env)), 'dry-run must write nothing');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('EAP-Lean: --only claude writes both blocks into CLAUDE.md and uninstall strips both, keeping user content', () => {
  const dir = mkTmp('lean-claude');
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), '# My rules\nKEEP-THIS-LINE\n');
    const r = run(['--only', 'claude', '--config-dir', dir, '--no-runtime', '--no-context', '--non-interactive', '--no-color']);
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(md, /eap-signal:begin/, 'signal block in CLAUDE.md');
    assert.match(md, /eap-lean:begin/, 'lean block in CLAUDE.md');
    assert.match(md, /Decision ladder/, 'real EAP-LEAN content');
    assert.match(md, /KEEP-THIS-LINE/, 'user content preserved');

    const u = run(['--uninstall', '--config-dir', dir, '--non-interactive', '--no-color']);
    assert.equal(u.status, 0, u.stderr);
    const md2 = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.doesNotMatch(md2, /eap-signal:begin/, 'signal block removed');
    assert.doesNotMatch(md2, /eap-lean:begin/, 'lean block removed');
    assert.match(md2, /KEEP-THIS-LINE/, 'user content survives uninstall');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
