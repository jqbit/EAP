#!/usr/bin/env node
// eapcrew model overrides — patch installed agent frontmatter from env vars.
// Adapted from TLDR tldrcrew-model-overrides.js (MIT).
//
// Env:
//   EAPCREW_REVIEWER_MODEL     → agents/eapcrew-reviewer.md
//   EAPCREW_BUILDER_MODEL      → agents/eapcrew-builder.md
//   EAPCREW_INVESTIGATOR_MODEL → agents/eapcrew-investigator.md

import fs from 'node:fs';
import path from 'node:path';

export const AGENT_ENV_MAP = [
  { envVar: 'EAPCREW_REVIEWER_MODEL', file: path.join('agents', 'eapcrew-reviewer.md') },
  { envVar: 'EAPCREW_BUILDER_MODEL', file: path.join('agents', 'eapcrew-builder.md') },
  { envVar: 'EAPCREW_INVESTIGATOR_MODEL', file: path.join('agents', 'eapcrew-investigator.md') },
];

export function resolvePluginRoot(hookDir) {
  return path.resolve(hookDir, '..');
}

export function patchFrontmatterModel(content, modelValue) {
  if (!modelValue || /[\x00-\x1f\x7f]/.test(modelValue)) return content;
  if (!content.startsWith('---')) return content;
  const closeIdx = content.indexOf('\n---', 3);
  if (closeIdx === -1) return content;
  const fmRaw = content.slice(0, closeIdx);
  const after = content.slice(closeIdx);
  const nl = fmRaw.includes('\r\n') ? '\r\n' : '\n';
  const modelLine = 'model: ' + modelValue;
  const modelRe = /^model:[ \t]*.*$/m;
  if (modelRe.test(fmRaw)) {
    const patched = fmRaw.replace(modelRe, modelLine);
    if (patched === fmRaw) return content;
    return patched + after;
  }
  const toolsMatch = fmRaw.match(/^tools:[ \t]*.*$/m);
  if (toolsMatch) {
    const toolsEnd = fmRaw.indexOf(toolsMatch[0]) + toolsMatch[0].length;
    return fmRaw.slice(0, toolsEnd) + nl + modelLine + fmRaw.slice(toolsEnd) + after;
  }
  return fmRaw + nl + modelLine + after;
}

export function applyOverrides(pluginRoot, env) {
  const envArg = env || process.env;
  for (const { envVar, file } of AGENT_ENV_MAP) {
    const raw = envArg[envVar];
    if (!raw || !raw.trim()) continue;
    const modelValue = raw.trim();
    if (/[\x00-\x1f\x7f]/.test(modelValue)) continue;
    const agentPath = path.join(pluginRoot, file);
    let content;
    try { content = fs.readFileSync(agentPath, 'utf8'); } catch { continue; }
    const patched = patchFrontmatterModel(content, modelValue);
    if (patched === content) continue;
    try { fs.writeFileSync(agentPath, patched, 'utf8'); } catch { /* silent */ }
  }
}
