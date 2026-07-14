#!/usr/bin/env node
// eap-signal-shrink — MCP middleware that proxies an upstream MCP server and
// compresses prose fields so the model sees fewer tokens.
//
// Usage:
//   node index.mjs <upstream-command> [...args]
//
// Example wrapping a filesystem MCP server:
//   "mcpServers": {
//     "fs-shrunk": {
//       "command": "node",
//       "args": ["…/eap-signal-shrink/index.mjs", "npx", "@modelcontextprotocol/server-filesystem", "/path"]
//     }
//   }
//
// Env:
//   EAP_SIGNAL_SHRINK_FIELDS   comma-separated fields (default: description)
//   EAP_SIGNAL_SHRINK_DEBUG=1  log compression deltas to stderr
//
// Adapted from TLDR tldr-shrink (MIT).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compress, compressDescriptionsInPlace } from './compress.mjs';
import { getSpawnOptions } from './spawn-options.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('eap-signal-shrink: missing upstream command.\n');
  process.stderr.write('Usage: eap-signal-shrink <upstream-command> [...args]\n');
  process.exit(2);
}

const debug = process.env.EAP_SIGNAL_SHRINK_DEBUG === '1';
const fields = (process.env.EAP_SIGNAL_SHRINK_FIELDS || 'description')
  .split(',').map((s) => s.trim()).filter(Boolean);

const LIST_METHODS = new Set([
  'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list',
]);
const idToMethod = new Map();

const upstream = spawn(args[0], args.slice(1), getSpawnOptions());

upstream.on('error', (err) => {
  process.stderr.write(`eap-signal-shrink: failed to spawn upstream: ${err.message}\n`);
  process.exit(1);
});

upstream.on('exit', (code, signal) => {
  if (signal) process.exit(128 + (signal === 'SIGTERM' ? 15 : 9));
  process.exit(code || 0);
});

function makeLineBuffer(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}

function transformResponse(msg) {
  if (!msg || !msg.result || typeof msg.result !== 'object') return msg;
  if (msg.id === undefined || msg.id === null) return msg;
  const method = idToMethod.get(msg.id);
  idToMethod.delete(msg.id);
  if (!method || !LIST_METHODS.has(method)) return msg;
  const r = msg.result;
  let compressedSomething = false;

  for (const arrayName of ['tools', 'prompts', 'resources', 'resourceTemplates']) {
    if (Array.isArray(r[arrayName])) {
      for (const item of r[arrayName]) {
        if (!item || typeof item !== 'object') continue;
        for (const field of fields) {
          if (typeof item[field] === 'string') {
            const before = item[field];
            const out = compress(before).compressed;
            if (out !== before) {
              item[field] = out;
              compressedSomething = true;
              if (debug) {
                process.stderr.write(
                  `[eap-signal-shrink] ${arrayName}.${item.name || '?'}.${field}: `
                  + `${before.length}→${out.length} bytes\n`
                );
              }
            }
          }
        }
      }
    }
  }

  if (!compressedSomething) compressDescriptionsInPlace(r, fields);
  return msg;
}

upstream.stdout.on('data', makeLineBuffer((line) => {
  let msg;
  try { msg = JSON.parse(line); } catch {
    process.stdout.write(line + '\n');
    return;
  }
  let out;
  try { out = JSON.stringify(transformResponse(msg)) + '\n'; }
  catch { out = line + '\n'; }
  process.stdout.write(out);
}));

const recordRequestMethods = makeLineBuffer((line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req && req.id !== undefined && req.id !== null
    && typeof req.method === 'string' && LIST_METHODS.has(req.method)) {
    idToMethod.set(req.id, req.method);
  }
});

process.stdin.on('data', (chunk) => {
  recordRequestMethods(chunk);
  upstream.stdin.write(chunk);
});
process.stdin.on('end', () => upstream.stdin.end());

// Mark entry for future packaging (no deps).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  /* stdio proxy running */
}
