// EAP — shared session-mode state for the always-on layers (Signal + Lean).
//
// A tiny flag file per layer records the active intensity level for the current
// session so `/eap signal <level>` and `/eap lean <level>` persist across turns
// and the SessionStart/SubagentStart hooks can inject only the active level's
// rules. Node built-ins only; every operation is best-effort and silent-failing
// (a hook must never crash the agent). Concept ported from ponytail's
// mode-tracker/runtime (MIT, © DietrichGebert) and re-expressed for EAP.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-layer valid levels. Absent flag ⇒ DEFAULTS[kind]. `off` disables injection.
export const LEVELS = {
  lean: ['off', 'lite', 'full', 'ultra'],
  signal: ['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra'],
};
export const DEFAULTS = { lean: 'full', signal: 'full' };

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function flagFile(kind) {
  return path.join(configDir(), `.eap-${kind}-active`);
}

// Read the active level for a layer. Returns DEFAULTS[kind] when unset/unreadable
// so a fresh session behaves as the documented default.
export function readMode(kind) {
  try {
    const raw = fs.readFileSync(flagFile(kind), 'utf8').trim();
    return LEVELS[kind].includes(raw) ? raw : DEFAULTS[kind];
  } catch { return DEFAULTS[kind]; }
}

// Persist a level. Silently no-ops on an invalid level or a write error.
export function setMode(kind, mode) {
  if (!LEVELS[kind] || !LEVELS[kind].includes(mode)) return false;
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(flagFile(kind), mode + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

// Remove the flag (revert to default). Swallows ENOENT.
export function clearMode(kind) {
  try { fs.unlinkSync(flagFile(kind)); return true; } catch { return false; }
}

// Parse a leading slash/at command out of a user prompt.
//   "/eap lean ultra"  -> { kind:'lean', mode:'ultra' }
//   "/eap signal off"  -> { kind:'signal', mode:'off' }
//   "/eap lean"        -> { kind:'lean', mode:null }  (query, no change)
// Returns null when the prompt is not an /eap switch.
export function parseSwitch(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.trim().match(/^[/@$]eap\s+(lean|signal)\b\s*([a-z-]+)?/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const arg = m[2] ? m[2].toLowerCase() : null;
  return { kind, mode: arg && LEVELS[kind].includes(arg) ? arg : null };
}

// Exact-match deactivation guard (ponytail-config.js:40-43 concept): only a
// whole message equal to a stop phrase reverts — so "add a normal mode toggle"
// never disables the layer mid-task. Returns 'lean' | 'signal' | 'both' | null.
export function parseDeactivate(prompt) {
  if (typeof prompt !== 'string') return null;
  const t = prompt.trim().toLowerCase().replace(/[.!?\s]+$/, '');
  if (t === 'stop eap' || t === 'normal mode') return 'both';
  if (t === 'stop lean' || t === 'stop eap lean') return 'lean';
  if (t === 'stop signal' || t === 'stop eap signal') return 'signal';
  return null;
}
