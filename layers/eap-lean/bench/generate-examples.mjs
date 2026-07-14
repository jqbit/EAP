#!/usr/bin/env node
// Generate examples/*.md verbatim from a local promptfoo output.json
// (baseline arm vs eap-lean arm, same model). Does not invent numbers.
//
//   npx promptfoo@latest eval -c promptfooconfig.yaml
//   node generate-examples.mjs
//
// Expects output.json next to this file (promptfoo default / copy it here).
// Port of ponytail/benchmarks/generate-examples.mjs (MIT) — EAP-branded.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const loc = require('./loc.cjs');
const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, 'output.json');

if (!existsSync(outPath)) {
  console.error('Missing bench/output.json — run promptfoo eval first, then copy/move output.json here.');
  process.exit(1);
}

const j = JSON.parse(readFileSync(outPath, 'utf8'));
const rows = j.results?.results || j.results || [];
if (!Array.isArray(rows) || !rows.length) {
  console.error('output.json has no results.results[] — refuse to invent examples.');
  process.exit(1);
}

const meta = [
  [/validates email/, 'email-validation', 'Email Validation'],
  [/debounce/, 'debounce', 'Debounce'],
  [/sales\.csv/, 'csv-sum', 'CSV Sum'],
  [/countdown timer/, 'react-countdown', 'Countdown Timer'],
  [/rate limiting/, 'rate-limit', 'Rate Limiting'],
];

const isLeanArm = (r) => /eap-lean/i.test(String(r.prompt?.label || r.promptId || ''));
const isBaseline = (r) => /baseline/i.test(String(r.prompt?.label || r.promptId || ''));

const pick = (re, pred) =>
  rows.find((r) => pred(r) && re.test(String(r.vars?.task || '')));

const table = [];
for (const [re, slug, title] of meta) {
  const b = pick(re, isBaseline);
  const p = pick(re, isLeanArm);
  if (!b || !p) {
    console.log('MISS', slug, !!b, !!p);
    continue;
  }
  const bOut = String(b.response?.output || b.output || '');
  const pOut = String(p.response?.output || p.output || '');
  const bL = loc(bOut).score;
  const pL = loc(pOut).score;
  const md = `# ${title}

**Task:** "${b.vars.task}"

Verbatim model output from a local benchmark run — no-skill arm vs EAP-Lean arm.
Reproduce: \`npx promptfoo@latest eval -c layers/eap-lean/bench/promptfooconfig.yaml\`.
Provenance: \`../../../docs/legal/ATTRIBUTION.md\`.

## Without EAP-Lean — ${bL} lines of code

${bOut.trim()}

## With EAP-Lean — ${pL} lines of code

${pOut.trim()}

**${bL} → ${pL} lines of code** — same model, same prompt.
`;
  writeFileSync(join(here, '..', 'examples', `${slug}.md`), md);
  table.push([title, slug, bL, pL]);
  console.log('wrote examples/' + slug + '.md', bL, '->', pL);
}

if (!table.length) {
  console.error('No examples written (arm labels or tasks unmatched).');
  process.exit(1);
}

console.log('done — update examples/README.md table by hand if needed.');
