// EAP — JSONC-tolerant settings read/write + defensive hook validation (ESM).
//
// Adapted from the MIT-licensed TLDR installer (bin/lib/settings.js, same
// author) and ported to ES modules with zero third-party dependencies: Node
// built-ins only. Used by bin/eap-install.mjs so a commented settings.json /
// .mcp.json never crashes the installer, and so uninstall can strip exactly the
// entries EAP added while preserving every user-authored one.
//
// Public API:
//   stripJsonComments(src)              -> comment/trailing-comma-stripped string
//   readSettings(path)                  -> object, {}, or null on hard parse failure
//   writeSettings(path, obj)            -> atomic 0600 write with trailing newline
//   validateHookFields(settings, warn)  -> mutate: drop structurally-hopeless hooks
//   hasCommandHook(settings, ev, mark)  -> idempotency probe
//   addCommandHook(settings, ev, opts)  -> idempotent push (marker/matcher/timeout)
//   removeCommandHooks(settings, mark)  -> uninstall helper (returns count removed)
//   upsertFencedBlock(text, b, e, body) -> insert/replace a marker-fenced block
//   stripFencedBlock(text, begin, end)  -> remove a marker-fenced block

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A plain, non-array object. Guards every mutation helper below so a
// settings.json / .mcp.json / opencode.jsonc whose root (or `hooks`) is a bare
// string / number / array never throws a TypeError that would abort the run.
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── atomic write ────────────────────────────────────────────────────────────
// Temp file on the SAME filesystem as the target (rename(2) is only atomic when
// source and destination share a device), restrictive perms, then rename.
export function atomicWrite(dest, content, mode = 0o600) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(dir, '.eap-atomic-'));
  try { fs.chmodSync(tempDir, 0o700); } catch { /* best effort */ }
  const tempFile = path.join(tempDir, 'write.tmp');
  try {
    fs.writeFileSync(tempFile, content, { mode });
    fs.renameSync(tempFile, dest);
  } finally {
    try { fs.unlinkSync(tempFile); } catch { /* already renamed */ }
    try { fs.rmdirSync(tempDir); } catch { /* best effort */ }
  }
}

// ── stripJsonComments ───────────────────────────────────────────────────────
// Hand-rolled state machine. Tracks string state + backslash escape so a
// comment-looking sequence inside a quoted string is left alone. Trailing
// commas are removed in a final pass (JSONC tolerates them, JSON.parse doesn't).
export function stripJsonComments(src) {
  if (typeof src !== 'string') return src;
  // Strip a leading UTF-8 BOM (U+FEFF) — JSON.parse rejects it, but an editor
  // may have written one into an otherwise valid settings file.
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = false;
  let stringChar = '';
  let inLine = false;
  let inBlock = false;
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (inLine) { if (c === '\n') { inLine = false; out += c; } i++; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (inString) {
      out += c;
      if (c === '\\') { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } }
      if (c === stringChar) inString = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; out += c; i++; continue; }
    if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  // String-aware trailing-comma sweep. A plain regex over `out` would also match
  // commas inside string VALUES (e.g. "TODO: fix,}"), corrupting user data that
  // then gets written back to disk. Walk char-by-char instead.
  return stripTrailingCommas(out);
}

function stripTrailingCommas(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let inString = false;
  let q = '';
  while (i < n) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) { out += s[i + 1]; i += 2; continue; }
      if (c === q) inString = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inString = true; q = c; out += c; i++; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(s[j])) j++;
      if (j < n && (s[j] === '}' || s[j] === ']')) { i++; continue; }
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// ── readSettings ────────────────────────────────────────────────────────────
// Strict JSON first (fast path); on failure strip comments and retry. Total
// failure returns null (never silently clobber a recoverable file with {}).
export function readSettings(p) {
  if (!fs.existsSync(p)) return {};
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { process.stderr.write(`eap: cannot read ${p}: ${e.message}\n`); return null; }
  if (!raw.trim()) return {};
  // Strip a leading UTF-8 BOM before parsing — a BOM-prefixed but otherwise
  // valid file must parse, not be treated as unrecoverable garbage.
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  try { return JSON.parse(raw); } catch { /* fall through to JSONC */ }
  try { return JSON.parse(stripJsonComments(raw)); }
  catch (e) {
    process.stderr.write(`eap: warning — ${p} is not valid JSON or JSONC: ${e.message}\n`);
    return null;
  }
}

// ── writeSettings ───────────────────────────────────────────────────────────
export function writeSettings(p, obj) {
  atomicWrite(p, JSON.stringify(obj, null, 2) + '\n', 0o600);
}

// ── validateHookFields ──────────────────────────────────────────────────────
// Claude Code uses strict Zod on settings.json — a single malformed hook
// silently discards the entire file. Drop only structurally-hopeless entries;
// preserve any object carrying an unrecognized-but-nonempty `type` (may be valid
// in a newer Claude Code than this installer knows about). Every drop reported.
export function validateHookFields(settings, warn) {
  if (!isPlainObject(settings)) return settings;
  if (!isPlainObject(settings.hooks)) return settings;
  const dropped = [];
  for (const ev of Object.keys(settings.hooks)) {
    const arr = settings.hooks[ev];
    if (!Array.isArray(arr)) { dropped.push(`${ev} (not an array)`); delete settings.hooks[ev]; continue; }
    settings.hooks[ev] = arr.filter((entry) => {
      if (!entry || typeof entry !== 'object') { dropped.push(`${ev} entry (not an object)`); return false; }
      if (!Array.isArray(entry.hooks)) { dropped.push(`${ev} entry (missing hooks array)`); return false; }
      entry.hooks = entry.hooks.filter((h) => {
        if (!h || typeof h !== 'object') { dropped.push(`${ev} hook (not an object)`); return false; }
        if (h.type === 'command') return typeof h.command === 'string' && h.command.length > 0;
        if (h.type === 'prompt' || h.type === 'agent') return typeof h.prompt === 'string' && h.prompt.length > 0;
        if (h.type === 'http') return typeof h.url === 'string' && h.url.length > 0;
        if (typeof h.type === 'string' && h.type.length > 0) return true;
        dropped.push(`${ev} hook (no type field)`);
        return false;
      });
      return entry.hooks.length > 0;
    });
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (dropped.length && typeof warn === 'function') {
    warn('settings.json: dropped malformed hook entries: ' + dropped.join('; '));
  }
  return settings;
}

// ── hasCommandHook ──────────────────────────────────────────────────────────
export function hasCommandHook(settings, event, marker) {
  const arr = settings && settings.hooks && settings.hooks[event];
  if (!Array.isArray(arr)) return false;
  return arr.some((e) =>
    e && Array.isArray(e.hooks) &&
    e.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(marker)));
}

// ── addCommandHook ──────────────────────────────────────────────────────────
// Idempotent push keyed on `marker` (a stable substring, e.g. the script
// basename). Optional `matcher` scopes PreToolUse/PostToolUse to a tool name.
export function addCommandHook(settings, event, opts) {
  // Defensive: a non-plain-object root can't carry a hooks map — bail rather
  // than throw a TypeError that would abort the run. A hooks field that is a
  // string / number / array (not the expected event->entries object) is reset,
  // since Claude Code's Zod would discard the whole file over it anyway.
  if (!isPlainObject(settings)) return false;
  if (!isPlainObject(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const marker = opts.marker || opts.command;
  for (const entry of settings.hooks[event]) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    const hook = entry.hooks.find((h) =>
      h && typeof h.command === 'string' && h.command.includes(marker));
    if (!hook) continue;
    // Reinstalls may run from a moved/updated checkout. Refresh the managed
    // command in place instead of treating any marker match as permanently
    // current; otherwise hooks keep executing an old checkout forever.
    hook.type = 'command';
    hook.command = opts.command;
    if (typeof opts.timeout === 'number') hook.timeout = opts.timeout;
    else delete hook.timeout;
    if (typeof opts.matcher === 'string' && opts.matcher) entry.matcher = opts.matcher;
    else delete entry.matcher;
    return false;
  }
  const hook = { type: 'command', command: opts.command };
  if (typeof opts.timeout === 'number') hook.timeout = opts.timeout;
  const entry = { hooks: [hook] };
  if (typeof opts.matcher === 'string' && opts.matcher) entry.matcher = opts.matcher;
  settings.hooks[event].push(entry);
  return true;
}

// ── removeCommandHooks ──────────────────────────────────────────────────────
// Strip every entry whose any hook command mentions `marker`; empties events.
// Preserves foreign / user-authored hooks untouched.
export function removeCommandHooks(settings, marker) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return 0;
  validateHookFields(settings);
  if (!isPlainObject(settings.hooks)) return 0; // validate may have deleted the tree
  let removed = 0;
  for (const ev of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[ev])) { delete settings.hooks[ev]; continue; }
    const before = settings.hooks[ev].length;
    settings.hooks[ev] = settings.hooks[ev].filter((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return true;
      return !entry.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(marker));
    });
    removed += before - settings.hooks[ev].length;
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

// ── marker-fenced block helpers (for CLAUDE.md / rules files) ────────────────
// A "well-formed block" is an END marker matched to its NEAREST PRECEDING BEGIN.
// This pairing is the data-loss-safe core the whole installer relies on: an
// orphan BEGIN (no following END), an orphan END (no preceding BEGIN), and an
// END-before-BEGIN sequence are all left in place as stray markers — surrounding
// user text is NEVER removed, and a stray marker is never adopted as a block
// boundary that would swallow the user content between it and the real block.

// Locate every well-formed [begin..end] block, nearest-preceding-BEGIN paired,
// non-overlapping, in document order. Returns [{ begin, end }] index ranges
// where `end` is EXCLUSIVE (one past the end marker).
function findFencedBlocks(body, begin, end) {
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const endPos = body.indexOf(end, searchFrom);
    if (endPos === -1) break;
    const beginPos = body.lastIndexOf(begin, endPos);
    if (beginPos === -1 || beginPos < searchFrom) {
      // END with no BEGIN in the unprocessed region — leave it, skip past it.
      searchFrom = endPos + end.length;
      continue;
    }
    blocks.push({ begin: beginPos, end: endPos + end.length });
    searchFrom = endPos + end.length;
  }
  return blocks;
}

// Concatenate surviving segments, collapsing blank lines at each removed-block
// seam (between adjacent segments) to a single newline — matching the historical
// single-block behavior. User text NOT at a seam is left byte-for-byte.
function joinCollapsingSeams(segments) {
  let text = '';
  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i];
    if (i > 0) seg = seg.replace(/^\n+/, '\n');                  // leading, at a cut
    if (i < segments.length - 1) seg = seg.replace(/\n+$/, '\n'); // trailing, at a cut
    text += seg;
  }
  return text;
}

// Insert or replace a managed block delimited by `begin`/`end`. UPSERT semantics:
//   • No well-formed block (plain text, or only orphan / end-before-begin
//     markers) → append a fresh block; every stray marker and user line survives.
//   • One or more well-formed blocks → replace the LAST block's body with the
//     current `body` and remove any earlier duplicate blocks (collapse to one),
//     preserving all surrounding user text. Byte-identical ⇒ no-op (idempotent),
//     so a reinstall refreshes a stale block instead of leaving it or appending.
export function upsertFencedBlock(existing, begin, end, body) {
  // blockCore carries NO trailing newline: the newline after the end marker
  // belongs to the surrounding file so an in-place replace is byte-idempotent.
  const blockCore = `${begin}\n${body.replace(/\n+$/, '')}\n${end}`;
  const fencedBlock = blockCore + '\n';
  if (existing == null || existing.trim() === '') return fencedBlock;
  const blocks = findFencedBlocks(existing, begin, end);
  if (blocks.length === 0) {
    // Append after the user's content; leave any orphan/unpaired marker intact.
    const sep = existing.endsWith('\n\n') ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
    return existing + sep + fencedBlock;
  }
  // Keep the LAST block (its span is replaced with the fresh body); drop every
  // earlier duplicate block, collapsing the blank lines at each removed seam.
  const last = blocks[blocks.length - 1];
  const segments = [existing.slice(0, blocks[0].begin)];
  for (let k = 1; k < blocks.length; k++) segments.push(existing.slice(blocks[k - 1].end, blocks[k].begin));
  const before = joinCollapsingSeams(segments); // text up to `last.begin`, earlier blocks gone
  const after = existing.slice(last.end);        // text after the kept block, byte-preserved
  return before + blockCore + after;
}

// Strip EVERY well-formed block (nearest-preceding pairing), preserving all
// surrounding user text and leaving orphan/unpaired markers in place. Returns
// { text, stripped }; `text` is '' when only whitespace survives (caller deletes
// the file). Byte-for-byte user content is retained apart from collapsed seams.
export function stripFencedBlock(existing, begin, end) {
  if (existing == null) return { text: null, stripped: false };
  const blocks = findFencedBlocks(existing, begin, end);
  if (blocks.length === 0) return { text: existing, stripped: false };
  const segments = [];
  let cursor = 0;
  for (const b of blocks) { segments.push(existing.slice(cursor, b.begin)); cursor = b.end; }
  segments.push(existing.slice(cursor));
  let text = joinCollapsingSeams(segments).trimEnd();
  text = text ? text + '\n' : '';
  return { text, stripped: true };
}

// ── claudeConfigDir ─────────────────────────────────────────────────────────
export function claudeConfigDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}
