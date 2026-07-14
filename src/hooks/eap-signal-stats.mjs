#!/usr/bin/env node
// eap-signal-stats — measured session figures for EAP-Signal.
// Honesty: output tokens / turns / model / active level only. No invented
// savings percentages or dollar claims. Optional compressed-memory byte deltas
// labelled approximate (~chars/4).
//
// Patterns adapted from TLDR hooks/tldr-stats.js (MIT), re-scoped for EAP honesty.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMode } from './eap-state.mjs';

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function findRecentSession(dir) {
  const projectsDir = path.join(dir, 'projects');
  let entries;
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); }
  catch { return null; }
  let best = null;
  const stack = entries.map((e) => path.join(projectsDir, e.name));
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      try {
        for (const child of fs.readdirSync(p)) stack.push(path.join(p, child));
      } catch { /* skip */ }
    } else if (p.endsWith('.jsonl') && (!best || st.mtimeMs > best.mtime)) {
      best = { file: p, mtime: st.mtimeMs };
    }
  }
  return best ? best.file : null;
}

function parseSession(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { outputTokens: 0, turns: 0, model: null }; }
  let outputTokens = 0;
  let turns = 0;
  let model = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message) continue;
    const usage = entry.message.usage;
    if (!usage) continue;
    outputTokens += usage.output_tokens || 0;
    turns++;
    if (!model && entry.message.model) model = entry.message.model;
  }
  return { outputTokens, turns, model };
}

function findCompressedPairs(dirs) {
  const pairs = [];
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.original.md')) continue;
      const base = entry.name.slice(0, -'.original.md'.length);
      const originalPath = path.join(dir, entry.name);
      const compressedPath = path.join(dir, `${base}.md`);
      let oSize, cSize;
      try {
        oSize = fs.statSync(originalPath).size;
        cSize = fs.statSync(compressedPath).size;
      } catch { continue; }
      if (oSize <= cSize) continue;
      pairs.push({ name: base, originalSize: oSize, compressedSize: cSize });
    }
  }
  return pairs;
}

export function formatStatsReport({ signal, session, pairs }) {
  const lines = [
    'EAP-Signal stats (measured)',
    `  active level: ${signal}`,
  ];
  if (session) {
    lines.push(`  session output tokens: ${session.outputTokens.toLocaleString('en-US')}`);
    lines.push(`  assistant turns: ${session.turns}`);
    if (session.model) lines.push(`  model: ${session.model}`);
  } else {
    lines.push('  session: (no transcript found)');
  }
  if (pairs && pairs.length) {
    const bytes = pairs.reduce((s, p) => s + (p.originalSize - p.compressedSize), 0);
    lines.push(`  memory compress pairs: ${pairs.length} (~${Math.round(bytes / 4).toLocaleString('en-US')} tokens est. from ${bytes.toLocaleString('en-US')} bytes; chars÷4 heuristic)`);
  }
  lines.push('  note: no savings % claimed — figures are session measurements only.');
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { sessionFile: null, share: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session-file') opts.sessionFile = argv[++i];
    else if (argv[i] === '--share') opts.share = true;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const signal = readMode('signal');
  const file = opts.sessionFile || findRecentSession(claudeDir());
  const session = file ? parseSession(file) : null;
  const pairs = findCompressedPairs([process.cwd(), claudeDir()]);
  const report = formatStatsReport({ signal, session, pairs: pairs.length ? pairs : null });
  if (opts.share) {
    process.stdout.write(`EAP-Signal ${signal} | out=${session ? session.outputTokens : 0} tok | turns=${session ? session.turns : 0}\n`);
  } else {
    process.stdout.write(report + '\n');
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch { process.exit(0); }
}
