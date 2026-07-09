#!/usr/bin/env node
// EAP — statusline script. Prints ONE line:
//
//   EAP Signal:full Lean:ultra | 12,345 bytes kept out of context
//
// Sources (both best-effort, both measured/declared — never modeled):
//   • active Signal/Lean levels from the same flag files eap-dispatch.mjs uses
//     (src/hooks/eap-state.mjs readMode);
//   • measured bytes-kept-out from the project's .eap/runtime.db store stats.
// Honesty (DESIGN.md): measured bytes only — no percentages, no dollar figures.
//
// Wiring (done by the installer, not here): settings.json statusLine ->
//   { "type": "command", "command": "node <repo>/src/hooks/eap-statusline.mjs" }
// The agent passes session JSON on stdin; we use its cwd to find .eap/.
//
// INVARIANT: like every EAP hook, this must never crash the agent — every step
// is best-effort and the script always exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readMode } from './eap-state.mjs';

function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

// Project dir: statusline stdin JSON (workspace.current_dir | cwd), else cwd.
export function projectDir(input) {
  if (input && typeof input === 'object') {
    const ws = input.workspace;
    if (ws && typeof ws === 'object' && typeof ws.current_dir === 'string' && ws.current_dir) return ws.current_dir;
    if (typeof input.cwd === 'string' && input.cwd) return input.cwd;
  }
  return process.cwd();
}

// Pure formatter: levels + measured stats -> the one-line status. No %/$.
export function formatStatus({ signal, lean, bytesKeptOut = null, docs = null }) {
  let line = `EAP Signal:${signal} Lean:${lean}`;
  if (Number.isFinite(bytesKeptOut) && bytesKeptOut > 0) {
    line += ` | ${bytesKeptOut.toLocaleString('en-US')} bytes kept out of context`;
    if (Number.isFinite(docs) && docs > 0) line += ` (${docs} doc${docs === 1 ? '' : 's'})`;
  }
  return line;
}

async function measuredBytes(dir) {
  try {
    const dbPath = process.env.EAP_DB || path.join(dir, '.eap', 'runtime.db');
    if (dbPath !== ':memory:' && !fs.existsSync(dbPath)) return {};
    const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'layers', 'eap-runtime', 'src');
    const { RuntimeStore } = await import(pathToFileURL(path.join(base, 'store.mjs')).href);
    const store = new RuntimeStore(dbPath);
    try { const s = store.stats(); return { bytesKeptOut: s.bytesKeptOut, docs: s.docs }; }
    finally { store.close(); }
  } catch { return {}; }
}

async function run() {
  try {
    const input = readStdinJson();
    const stats = await measuredBytes(projectDir(input));
    process.stdout.write(formatStatus({ signal: readMode('signal'), lean: readMode('lean'), ...stats }) + '\n');
  } catch { /* silent-fail invariant */ }
  process.exit(0);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) run();
