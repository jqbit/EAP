// EAP — shared session-mode state for the always-on layers (Signal + Lean).
//
// A tiny flag file per layer records the active intensity level for the current
// session so `/eap signal <level>` and `/eap lean <level>` persist across turns
// and the SessionStart/SubagentStart hooks can inject only the active level's
// rules. Node built-ins only; every operation is best-effort and silent-failing
// (a hook must never crash the agent). Concept ported from ponytail's
// mode-tracker/runtime (MIT) and TLDR/caveman mode trackers (MIT).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-layer valid levels. Absent flag ⇒ resolveDefault(kind). `off` disables injection.
// Signal independent skill-modes (commit/review/compress) share the flag file so
// statusline/hooks can suppress base-Signal reinforcement while those skills run.
export const INDEPENDENT_SIGNAL_MODES = ['commit', 'review', 'compress'];
export const LEVELS = {
  lean: ['off', 'lite', 'full', 'ultra'],
  signal: [
    'off', 'lite', 'full', 'ultra',
    'wenyan-lite', 'wenyan-full', 'wenyan-ultra',
    ...INDEPENDENT_SIGNAL_MODES,
  ],
};
export const DEFAULTS = { lean: 'full', signal: 'full' };

// Alias: bare `wenyan` → wenyan-full (documented default).
export function normalizeSignalArg(arg) {
  if (!arg) return null;
  const a = String(arg).toLowerCase();
  if (a === 'wenyan') return 'wenyan-full';
  if (a === 'stop' || a === 'disable') return 'off';
  return a;
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function flagFile(kind) {
  return path.join(configDir(), `.eap-${kind}-active`);
}

function userConfigPath() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'eap', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'eap', 'config.json');
}

function projectConfigPath() {
  return path.join(process.cwd(), '.eap', 'config.json');
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}

/** Alias — same as resolveDefault (docs / callers may use either name). */
export function getDefaultMode(kind) {
  return resolveDefault(kind);
}

// Resolve user/project/env default for a layer (used when session flag absent).
// Order: EAP_*_DEFAULT_MODE env → project .eap/config.json → ~/.config/eap/config.json
// (Windows: %APPDATA%\eap\config.json) → DEFAULTS.
export function resolveDefault(kind) {
  if (!LEVELS[kind]) return 'full';
  const envKey = kind === 'lean' ? 'EAP_LEAN_DEFAULT_MODE' : 'EAP_SIGNAL_DEFAULT_MODE';
  const envVal = typeof process.env[envKey] === 'string' ? process.env[envKey].trim().toLowerCase() : '';
  if (envVal && LEVELS[kind].includes(envVal) && !INDEPENDENT_SIGNAL_MODES.includes(envVal)) {
    return envVal;
  }
  for (const p of [projectConfigPath(), userConfigPath()]) {
    const cfg = readJson(p);
    if (!cfg || typeof cfg !== 'object') continue;
    const raw = kind === 'lean' ? (cfg.leanDefaultMode || cfg.defaultMode) : cfg.signalDefaultMode;
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (key && LEVELS[kind].includes(key) && !INDEPENDENT_SIGNAL_MODES.includes(key)) {
      return key;
    }
  }
  return DEFAULTS[kind];
}

export function writeDefaultMode(kind, mode) {
  if (!LEVELS[kind] || !LEVELS[kind].includes(mode) || INDEPENDENT_SIGNAL_MODES.includes(mode)) return false;
  try {
    const p = userConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const cfg = readJson(p) || {};
    if (kind === 'lean') {
      cfg.leanDefaultMode = mode;
      cfg.defaultMode = mode;
    } else {
      cfg.signalDefaultMode = mode;
    }
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

export function readMode(kind) {
  try {
    const raw = fs.readFileSync(flagFile(kind), 'utf8').trim();
    return LEVELS[kind].includes(raw) ? raw : resolveDefault(kind);
  } catch { return resolveDefault(kind); }
}

export function setMode(kind, mode) {
  if (!LEVELS[kind] || !LEVELS[kind].includes(mode)) return false;
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(flagFile(kind), mode + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

export function clearMode(kind) {
  try { fs.unlinkSync(flagFile(kind)); return true; } catch { return false; }
}

export function isIndependentSignalMode(mode) {
  return INDEPENDENT_SIGNAL_MODES.includes(mode);
}

// Opt-in SubagentStart scoping. Unset / invalid regex / empty agentType → fail-open.
export function subagentMatcherAllows(agentType, envVar, fallbackEnv) {
  const raw = process.env[envVar]
    || (fallbackEnv ? process.env[fallbackEnv] : '')
    || '';
  if (!String(raw).trim()) return true;
  try {
    // Case-insensitive, unanchored — same contract as PONYTAIL_SUBAGENT_MATCHER.
    const re = new RegExp(raw, 'i');
    const t = typeof agentType === 'string' ? agentType.trim() : '';
    if (!t) return true;
    return re.test(t);
  } catch { return true; }
}

// Parse a leading slash/at command out of a user prompt.
//   "/eap lean ultra"           -> { kind:'lean', mode:'ultra' }
//   "/eap signal wenyan"        -> { kind:'signal', mode:'wenyan-full' }
//   "/eap lean default ultra"   -> { kind:'lean', defaultMode:'ultra' }
//   "/eap-signal-commit"        -> { kind:'signal', mode:'commit' }
export function parseSwitch(prompt) {
  if (typeof prompt !== 'string') return null;
  const t = prompt.trim();

  const ind = t.match(/^[/@$](?:eap-signal|eap)(?::eap-signal)?-(commit|review|compress)\b/i);
  if (ind) return { kind: 'signal', mode: ind[1].toLowerCase() };

  // /eap <kind> default <mode>
  const def = t.match(/^[/@$]eap\s+(lean|signal)\s+default\s+([a-z-]+)\b/i);
  if (def) {
    const kind = def[1].toLowerCase();
    let arg = def[2].toLowerCase();
    if (kind === 'signal') arg = normalizeSignalArg(arg);
    if (arg && LEVELS[kind].includes(arg) && !INDEPENDENT_SIGNAL_MODES.includes(arg)) {
      return { kind, defaultMode: arg };
    }
    return { kind, defaultMode: null };
  }

  // /eap-signal [level]
  const bare = t.match(/^[/@$]eap-signal(?:\s+([a-z-]+))?\s*$/i);
  if (bare) {
    const arg = normalizeSignalArg(bare[1] || null);
    return { kind: 'signal', mode: arg && LEVELS.signal.includes(arg) ? arg : null };
  }

  const m = t.match(/^[/@$]eap\s+(lean|signal)\b\s*([a-z-]+)?/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const rawArg = m[2] ? m[2].toLowerCase() : null;
  const arg = kind === 'signal' ? normalizeSignalArg(rawArg) : rawArg;
  return { kind, mode: arg && LEVELS[kind].includes(arg) ? arg : null };
}

// Natural-language activate (TLDR/caveman mode-tracker pattern).
export function parseNaturalActivate(prompt) {
  if (typeof prompt !== 'string') return null;
  const p = prompt.trim();
  if (/\b(stop|disable|turn off|deactivate)\b/i.test(p)) return null;
  const on =
    /\b(activate|enable|turn on|start|talk like)\b.*\b(eap[- ]?signal|tldr|signal mode)\b/i.test(p)
    || /\b(eap[- ]?signal|tldr)\b.*\b(mode|activate|enable|turn on|start)\b/i.test(p)
    || /\btalk\s+tldr\b/i.test(p)
    || /\btldr\s+mode\b/i.test(p)
    || /\bsignal\s+mode\b/i.test(p);
  if (!on) return null;
  return { kind: 'signal', mode: resolveDefault('signal') };
}

export function parseDeactivate(prompt) {
  if (typeof prompt !== 'string') return null;
  const t = prompt.trim().toLowerCase().replace(/[.!?\s]+$/, '');
  if (t === 'stop eap' || t === 'normal mode') return 'both';
  if (t === 'stop lean' || t === 'stop eap lean') return 'lean';
  if (
    t === 'stop signal' || t === 'stop eap signal' || t === 'stop tldr'
    || t === 'stop eap-signal'
  ) return 'signal';
  if (/^(stop|disable|deactivate|turn off)\s+(eap[- ]?)?signal$/.test(t)) return 'signal';
  if (/^(stop|disable|deactivate|turn off)\s+tldr$/.test(t)) return 'signal';
  return null;
}
