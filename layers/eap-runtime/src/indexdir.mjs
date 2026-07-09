// EAP-Runtime — directory/file indexing for eap_index (clean-room).
//
// Extends eap_index beyond inline blobs: given a path, index one file, or walk
// a directory tree and index each text file. Bounded on purpose (max files,
// per-file byte cap) with a clear truncation report — never a silent partial
// index. Binary files are skipped (NUL-byte sniff + a small extension list);
// common vendored/VCS dirs are excluded. There is no .gitignore parser in this
// repo, so excludes are a fixed conservative list — stated in the report.
//
// Node built-ins only.

import { statSync, readdirSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 256 * 1024;

// Fixed exclude list (no .gitignore helper exists in this repo — documented).
export const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.eap', 'dist', 'build', 'target',
  '__pycache__', '.venv', 'venv', '.cache',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.tar', '.bz2', '.xz', '.7z', '.woff', '.woff2', '.ttf', '.eot', '.mp3',
  '.mp4', '.mov', '.avi', '.wasm', '.so', '.dylib', '.dll', '.exe', '.o',
  '.a', '.class', '.jar', '.db', '.sqlite', '.sqlite3',
]);

// Binary sniff: known binary extension, or a NUL byte in the first 8 KB.
export function isBinary(path) {
  if (BINARY_EXTS.has(extname(path).toLowerCase())) return true;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).includes(0);
    } finally { closeSync(fd); }
  } catch { return true; } // unreadable: treat as skip
}

// Deterministic walk (sorted entries), bounded by maxFiles. Returns file paths;
// sets report.walkTruncated when the bound bit.
function walk(root, maxFiles, report) {
  const files = [];
  const dirs = [root];
  while (dirs.length) {
    const dir = dirs.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { report.skipped.push({ path: dir, reason: 'unreadable-dir' }); continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) report.excludedDirs.push(relative(root, p) || e.name);
        else dirs.push(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (files.length >= maxFiles) { report.walkTruncated = true; return files; }
      files.push(p);
    }
  }
  return files;
}

// Index a file or directory into the store. Returns a report:
//   { path, kind: 'file'|'dir', indexed: [{id, source, bytes, chunks, truncated}],
//     skipped: [{path, reason}], excludedDirs, walkTruncated, hint }
export function indexPath(store, path, {
  maxFiles = MAX_FILES,
  maxFileBytes = MAX_FILE_BYTES,
  createdAt = 0,
} = {}) {
  let st;
  try { st = statSync(path); }
  catch { return { error: 'not-found', message: `No such path: ${path}` }; }

  const report = { path, kind: st.isDirectory() ? 'dir' : 'file', indexed: [], skipped: [], excludedDirs: [], walkTruncated: false };
  const files = st.isDirectory() ? walk(path, maxFiles, report) : [path];

  for (const f of files) {
    if (isBinary(f)) { report.skipped.push({ path: f, reason: 'binary' }); continue; }
    let body;
    try { body = readFileSync(f, 'utf8'); }
    catch { report.skipped.push({ path: f, reason: 'unreadable' }); continue; }
    if (!body.trim()) { report.skipped.push({ path: f, reason: 'empty' }); continue; }
    const over = Buffer.byteLength(body) > maxFileBytes;
    if (over) body = body.slice(0, maxFileBytes); // per-file cap; flagged below
    const p = store.index(f, body, { createdAt });
    report.indexed.push({ ...p, truncated: over });
  }

  const truncNotes = [];
  if (report.walkTruncated) truncNotes.push(`walk stopped at the ${maxFiles}-file bound — the tree has more files`);
  const cut = report.indexed.filter((i) => i.truncated).length;
  if (cut) truncNotes.push(`${cut} file(s) truncated at the ${maxFileBytes}-byte per-file cap`);
  report.hint = `Indexed ${report.indexed.length} file(s) from ${path} `
    + `(${report.skipped.length} skipped: binary/empty/unreadable; fixed excludes: .git, node_modules, .eap, …). `
    + (truncNotes.length ? `TRUNCATED: ${truncNotes.join('; ')}. ` : '')
    + 'Query with eap_search(query) or eap_search(query, { docId }).';
  return report;
}
