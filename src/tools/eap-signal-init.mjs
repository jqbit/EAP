#!/usr/bin/env node
// eap-signal-init — drop the always-on EAP-Signal activation rule into a
// target repo for IDE agents. Idempotent. Safe to re-run.
// Adapted from TLDR tldr-init.js / caveman-init.js (MIT). ESM to match EAP.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const RULE_BODY = `Respond in EAP-Signal style: verdict first, no filler. All technical substance stays.

Rules:
- 1 sentence default. 3-word target. 6-word hard max unless correctness requires more.
- No preamble, filler, postscript, recap, hedges. Verdict first.
- Shapes: confirm/opinion → verdict first; error → 1 cause + 1 fix ≤6w; cmd/code → artifact only; flawed premise → correct first (shortest).
- Fragments OK. Drop articles. Never open with validation. Answer-only. Prioritize truth and utility.
- Expansion only on explicit request.

Switch: /eap signal lite|full|ultra|wenyan
Stop: "stop signal" or "normal mode"

Auto-Clarity: drop Signal for security warnings, irreversible actions, ambiguity risk, user confusion. Resume after.

Boundaries: code/commits/PRs written normal.
`;

const SENTINEL = 'Respond in EAP-Signal style';
const LEGACY_SENTINELS = [
  'Respond in TLDR style',
  'Respond terse like smart caveman',
];

function atomicWrite(dest, content, mode = 0o644) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(dir, '.eap-signal-init-'));
  const tmp = path.join(tmpDir, 'rule');
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, dest);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    try { fs.rmdirSync(tmpDir); } catch { /* */ }
  }
}

export const AGENTS = [
  {
    id: 'cursor',
    file: '.cursor/rules/eap-signal.mdc',
    frontmatter: '---\ndescription: "EAP-Signal — verdict-first output compression"\nalwaysApply: true\n---\n\n',
    mode: 'replace',
  },
  {
    id: 'windsurf',
    file: '.windsurf/rules/eap-signal.md',
    frontmatter: '---\ntrigger: always_on\n---\n\n',
    mode: 'replace',
  },
  { id: 'cline', file: '.clinerules/eap-signal.md', frontmatter: '', mode: 'replace' },
  { id: 'copilot', file: '.github/copilot-instructions.md', frontmatter: '', mode: 'append' },
  { id: 'opencode', file: '.opencode/AGENTS.md', frontmatter: '', mode: 'append' },
  { id: 'agents', file: 'AGENTS.md', frontmatter: '', mode: 'append' },
];

export function loadRuleBody() {
  try {
    const local = path.join(REPO_ROOT, 'layers', 'eap-signal', 'rules', 'eap-signal-activate.md');
    if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8').trimEnd() + '\n';
  } catch { /* embedded */ }
  return RULE_BODY;
}

function alreadyInstalled(existing) {
  if (existing.includes(SENTINEL)) return true;
  return LEGACY_SENTINELS.some((s) => existing.includes(s));
}

export function processAgent(agent, targetDir, ruleBody, opts) {
  const fullPath = path.join(targetDir, agent.file);
  const exists = fs.existsSync(fullPath);

  if (!exists) {
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      atomicWrite(fullPath, agent.frontmatter + ruleBody, 0o644);
    }
    return { status: 'added', label: '+' };
  }

  const existing = fs.readFileSync(fullPath, 'utf8');
  if (alreadyInstalled(existing)) {
    return { status: 'skipped-already-installed', label: '=' };
  }

  if (agent.mode === 'append') {
    if (!opts.dryRun) {
      const sep = existing.endsWith('\n\n') ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
      atomicWrite(fullPath, existing + sep + ruleBody, 0o644);
    }
    return { status: 'appended', label: '~' };
  }

  if (opts.force) {
    if (!opts.dryRun) atomicWrite(fullPath, agent.frontmatter + ruleBody, 0o644);
    return { status: 'overwritten', label: '!' };
  }

  return { status: 'skipped-exists', label: '?' };
}

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, only: null, target: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (!a.startsWith('-')) opts.target = path.resolve(a);
  }
  return opts;
}

function help() {
  console.log(`eap-signal-init — drop always-on EAP-Signal rule into a target repo

Usage: eap-signal-init.mjs [target-dir] [--dry-run] [--force] [--only <agent>]

Targets:
${AGENTS.map((a) => `  ${a.id.padEnd(10)} ${a.file}`).join('\n')}
`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return; }

  console.log(`EAP-Signal init — ${opts.target}${opts.dryRun ? ' (dry run)' : ''}\n`);
  const ruleBody = loadRuleBody();
  const counts = { added: 0, appended: 0, overwritten: 0, skipped: 0 };

  for (const agent of AGENTS) {
    if (opts.only && opts.only !== agent.id) continue;
    const result = processAgent(agent, opts.target, ruleBody, opts);
    console.log(`  ${result.label} ${agent.file} (${result.status})`);
    if (result.status === 'added') counts.added++;
    else if (result.status === 'appended') counts.appended++;
    else if (result.status === 'overwritten') counts.overwritten++;
    else counts.skipped++;
  }

  console.log(`\n${counts.added} added, ${counts.appended} appended, `
    + `${counts.overwritten} overwritten, ${counts.skipped} skipped`);
  if (opts.dryRun) console.log('(dry run — no files were written)');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
