// Tests for directory/file indexing (layers/eap-runtime/src/indexdir.mjs) and
// its eap_index wiring in the MCP dispatcher. Run: node --test tests/index-dir.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexPath, isBinary, MAX_FILES } from '../layers/eap-runtime/src/indexdir.mjs';
import { RuntimeStore } from '../layers/eap-runtime/src/store.mjs';
import { createDispatcher } from '../layers/eap-runtime/src/mcp.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'eap-idx-'));
  writeFileSync(join(dir, 'alpha.txt'), 'the quick zephyr vaults over MARKER_ALPHA content\n');
  writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(join(dir, 'empty.txt'), '   \n');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'beta.md'), 'nested MARKER_BETA document body\n');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'MARKER_EXCLUDED should never be indexed\n');
  return dir;
}

test('indexPath walks a directory: text files in, binaries/empties/excluded dirs out', () => {
  const dir = fixture();
  const store = new RuntimeStore(':memory:');
  try {
    const r = indexPath(store, dir, { createdAt: 1 });
    assert.equal(r.kind, 'dir');
    assert.equal(r.indexed.length, 2); // alpha.txt + sub/beta.md
    assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['binary', 'empty']);
    assert.ok(r.excludedDirs.includes('node_modules'));
    assert.equal(r.walkTruncated, false);
    // Indexed content is searchable; excluded content is not.
    assert.ok(store.search('MARKER_BETA').length > 0);
    assert.equal(store.search('MARKER_EXCLUDED').length, 0);
    assert.match(r.hint, /eap_search/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('indexPath bounds: maxFiles stops the walk, per-file cap truncates and reports', () => {
  const dir = fixture();
  const store = new RuntimeStore(':memory:');
  try {
    writeFileSync(join(dir, 'huge.txt'), 'padword '.repeat(200)); // 1600 bytes
    const r = indexPath(store, dir, { maxFiles: 1, maxFileBytes: 100, createdAt: 1 });
    assert.equal(r.walkTruncated, true);
    assert.equal(r.indexed.length, 1);
    assert.match(r.hint, /TRUNCATED/);
    const capped = indexPath(store, join(dir, 'huge.txt'), { maxFileBytes: 100, createdAt: 1 });
    assert.equal(capped.kind, 'file');
    assert.equal(capped.indexed[0].truncated, true);
    assert.ok(capped.indexed[0].bytes <= 100);
    assert.match(capped.hint, /per-file/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('indexPath: missing path is a clean error; isBinary sniffs NUL bytes', () => {
  const store = new RuntimeStore(':memory:');
  try {
    const r = indexPath(store, '/no/such/path/at/all');
    assert.equal(r.error, 'not-found');
  } finally { store.close(); }
  assert.equal(isBinary('/also/missing.xyz'), true); // unreadable -> skip
});

test('eap_index MCP tool: path mode works and inline source+content stays backward-compatible', async () => {
  const dir = fixture();
  const store = new RuntimeStore(':memory:');
  const dispatch = createDispatcher({ store, now: () => 1 });
  const call = (args) => dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eap_index', arguments: args } });
  try {
    const dirRes = (await call({ path: dir })).result.structuredContent;
    assert.equal(dirRes.kind, 'dir');
    assert.equal(dirRes.indexed.length, 2);
    const inline = (await call({ source: 'blob', content: 'inline MARKER_INLINE body' })).result.structuredContent;
    assert.match(inline.id, /^eap_/); // old shape: single pointer descriptor
    assert.ok(store.search('MARKER_INLINE').length > 0);
    const bad = (await call({})).result; // neither path nor content -> tool error, not a crash
    assert.equal(bad.isError, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
