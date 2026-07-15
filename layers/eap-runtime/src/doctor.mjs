// EAP-Runtime — expanded health checks for eap_doctor (clean-room).
//
// Reports node version, sqlite/FTS, language runtimes, store integrity, MCP
// server version, and (best-effort) whether EAP hooks appear registered in a
// settings file. Never "heals" via better-sqlite3 or any third-party sqlite —
// a missing node:sqlite is a failure, not a fallback (DESIGN.md exclusions).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeSqlite } from './store.mjs';
import { runtimeAvailability } from './executor.mjs';

// Keep in sync with SERVER_INFO in mcp.mjs (avoid circular import).
const RUNTIME_VERSION = '0.3.0';
const RUNTIME_NAME = 'eap-runtime';

const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'];

/**
 * Scan a Claude/Cursor-style settings.json for eap-dispatch hook commands.
 * Inject paths for tests; defaults look at common config locations under HOME.
 */
export function detectHooksRegistered({
  settingsPaths = null,
  home = process.env.HOME || '',
  marker = 'eap-dispatch',
} = {}) {
  // Dedup: when cwd == home the .claude/settings.json path repeats, which would
  // otherwise list the same file twice in settingsFiles (and re-scan it).
  const candidates = [...new Set(settingsPaths || [
    join(home, '.claude', 'settings.json'),
    join(home, '.config', 'claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.cursor', 'hooks.json'),
  ])];
  const found = [];
  const events = Object.fromEntries(HOOK_EVENTS.map((e) => [e, false]));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    if (!text.includes(marker)) continue;
    found.push(p);
    let json;
    try { json = JSON.parse(text); } catch { continue; }
    const hooks = json.hooks || json;
    for (const ev of HOOK_EVENTS) {
      const arr = hooks && hooks[ev];
      if (!Array.isArray(arr)) continue;
      const hit = arr.some((entry) => {
        const list = entry?.hooks || (entry?.command ? [entry] : []);
        return Array.isArray(list) && list.some((h) =>
          h && typeof h.command === 'string' && h.command.includes(marker));
      });
      if (hit) events[ev] = true;
    }
  }
  const registeredEvents = HOOK_EVENTS.filter((e) => events[e]);
  return {
    ok: found.length > 0 && registeredEvents.length > 0,
    settingsFiles: found,
    events,
    registeredEvents,
    missingEvents: HOOK_EVENTS.filter((e) => !events[e]),
    note: found.length === 0
      ? 'No settings file with eap-dispatch found — run node bin/eap-install.mjs if hooks should be wired.'
      : undefined,
  };
}

export function runDoctor({
  store = null,
  settingsPaths = null,
  home = process.env.HOME || '',
} = {}) {
  const sqlite = probeSqlite();
  const nodeMajor = Number.parseInt(String(process.versions.node).split('.')[0], 10);
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= 22 && sqlite.ok;
  const storeHealth = store && typeof store.health === 'function'
    ? store.health()
    : { ok: false, integrity: 'no-store', docs: 0, bytesKeptOut: 0, chunks: 0 };
  const hooks = detectHooksRegistered({ settingsPaths, home });
  const runtimes = runtimeAvailability();

  const ok = nodeOk && storeHealth.ok === true;
  return {
    ok,
    version: RUNTIME_VERSION,
    server: RUNTIME_NAME,
    node: process.version,
    nodeOk,
    platform: process.platform,
    sqlite,
    runtimes,
    store: storeHealth,
    hooks,
    // Honest: we never auto-heal sqlite with a native addon.
    heal: {
      attempted: false,
      policy: 'no better-sqlite3 / native-sqlite fallback — upgrade Node >= 22 if sqlite.ok is false',
    },
  };
}
