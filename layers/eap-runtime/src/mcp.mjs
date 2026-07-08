// EAP-Runtime — minimal MCP-style JSON-RPC server over stdio (clean-room).
//
// FRAMING (documented choice): newline-delimited JSON — exactly one complete
// JSON-RPC 2.0 message per LF-terminated line on stdin/stdout, no
// Content-Length headers. This matches the MCP stdio transport and keeps the
// reader a plain node:readline loop. Messages must not contain embedded
// newlines (JSON.stringify never emits raw newlines, so responses are safe).
//
// Methods: initialize, ping, tools/list, tools/call (notifications/* are
// accepted and ignored). Tools exposed (DESIGN.md "Public interface"):
//   eap_execute            run a script in a subprocess; stdout only, auto-offloaded
//   eap_execute_file       run an existing script file from disk
//   eap_batch_execute      run several scripts, bounded and sequential
//   eap_index              chunk + index content behind a searchable pointer
//   eap_search             lossless chunk retrieval (RRF-fused) from the FTS store
//   eap_fetch              SSRF-hardened URL fetch; reduced text, auto-offloaded
//   eap_fetch_and_index    fetch + index a URL; return a searchable pointer
//   eap_stats              measured bytes kept out of context + token estimate
//   eap_offload            inline-or-pointer decision for arbitrary content
//   eap_purge              clear the store or a single document
//   eap_doctor             self-check: node, runtimes, sqlite, store health
//   eap_session_snapshot   priority-tiered <=2KB snapshot (PreCompact)
//   eap_session_restore    persisted snapshot + project-memory pointers (SessionStart)
//
// The dispatch layer (createDispatcher) is a pure function of its injected
// store/session/executor/fetch/clock — testable without a live stdio loop or
// real network.
//
// Zero third-party dependencies: node:readline, node:fs, node:path + siblings.

import { createInterface } from 'node:readline';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RuntimeStore, probeSqlite } from './store.mjs';
import { SessionLog } from './session.mjs';
import { executeScript, executeFile, executeBatch, runtimeAvailability } from './executor.mjs';
import { fetchUrl } from './fetch.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'eap-runtime', version: '0.2.0' };

const LANGUAGE_ENUM = [
  'python3', 'python', 'node', 'javascript', 'js', 'bash', 'sh', 'ruby', 'go',
  'rust', 'php', 'perl', 'r', 'elixir', 'typescript', 'ts', 'csharp',
];

export const TOOLS = [
  {
    name: 'eap_execute',
    description: 'Run a short script in a subprocess (python3|node|bash|ruby|go|rust|php|perl|r|elixir|typescript|csharp — missing runtimes fail cleanly). Only printed stdout returns to context; oversized stdout is indexed and a searchable pointer is returned instead. With an `intent`, an offloaded result returns the intent-matching chunks + a term vocabulary. Network calls are refused by policy — use eap_fetch for URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Script source to run.' },
        language: { type: 'string', enum: LANGUAGE_ENUM, default: 'python3' },
        timeoutMs: { type: 'number', description: 'Wall-clock timeout in ms.' },
        intent: { type: 'string', description: 'If set and output is offloaded, return only intent-matching chunks + a vocabulary.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'eap_execute_file',
    description: 'Run an existing script file from disk. Language is inferred from the extension unless given. The file runs in place (cwd = its directory). Same stdout-only / auto-offload / network-policy behaviour as eap_execute.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the script file.' },
        language: { type: 'string', enum: LANGUAGE_ENUM },
        timeoutMs: { type: 'number' },
        intent: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'eap_batch_execute',
    description: 'Run several scripts sequentially (bounded to 20). Returns per-script results. Each item: { script, language?, timeoutMs?, intent? }.',
    inputSchema: {
      type: 'object',
      properties: {
        scripts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              script: { type: 'string' },
              language: { type: 'string', enum: LANGUAGE_ENUM },
              timeoutMs: { type: 'number' },
              intent: { type: 'string' },
            },
            required: ['script'],
          },
        },
      },
      required: ['scripts'],
    },
  },
  {
    name: 'eap_index',
    description: 'Chunk and index a blob/string into the local full-text store; returns a pointer descriptor {id, chunks, bytes}.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Label for the content origin (e.g. a path).' },
        content: { type: 'string' },
      },
      required: ['source', 'content'],
    },
  },
  {
    name: 'eap_search',
    description: 'Query the full-text store; returns exact matching chunks (lossless, RRF-fused keyword+substring) with source spans and a locator snippet, never summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 5 },
        docId: { type: 'string', description: 'Restrict to one indexed document.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'eap_fetch',
    description: 'Fetch an http/https URL with SSRF hardening (scheme allowlist; IMDS/loopback/private/link-local blocked; DNS-rebind pinned; byte cap; timeout; TTL cache). HTML is reduced to text. Small text returns inline; large text is indexed and a searchable pointer is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https URL.' },
        timeoutMs: { type: 'number' },
        maxBytes: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'eap_fetch_and_index',
    description: 'Fetch an http/https URL (same SSRF hardening as eap_fetch), reduce HTML to text, index it, and return a searchable pointer + a term vocabulary — never the raw body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        timeoutMs: { type: 'number' },
        maxBytes: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'eap_stats',
    description: 'Report measured bytes kept out of context (a real sum of indexed bytes) plus an estimated token count (~bytes/4 heuristic, labelled — not a modeled percentage, no dollar figure).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'eap_offload',
    description: 'Offload decision for arbitrary content: small content returns inline; large content is indexed and a searchable pointer is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        content: { type: 'string' },
        threshold: { type: 'number', description: 'Override the offload threshold (bytes).' },
      },
      required: ['source', 'content'],
    },
  },
  {
    name: 'eap_purge',
    description: 'Maintenance: clear the whole store, or drop a single document when `docId` is given. Returns the number of documents removed.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Drop only this document; omit to clear everything.' },
      },
    },
  },
  {
    name: 'eap_doctor',
    description: 'Self-check: node version, language-runtime availability (python/node/bash/ruby/go/rust/php/perl/r/elixir/typescript/csharp), node:sqlite + FTS5/trigram support, and store health.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'eap_session_snapshot',
    description: 'Build and persist a compact priority-tiered session snapshot (<= ~2KB) with per-section retrieval hints. Call at PreCompact.',
    inputSchema: {
      type: 'object',
      properties: {
        ts: { type: 'number', description: 'Snapshot timestamp (defaults to server clock).' },
        maxBytes: { type: 'number', default: 2048 },
      },
    },
  },
  {
    name: 'eap_session_restore',
    description: 'Return the last persisted session snapshot (or null), plus pointers to any project memory files (CLAUDE.md/AGENTS.md) present — their content is never read or injected. Call at SessionStart.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function requireString(args, key) {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return v;
}

function summarizeCall(name, args) {
  const bits = [];
  if (typeof args.source === 'string') bits.push(args.source.slice(0, 80));
  if (typeof args.url === 'string') bits.push(args.url.slice(0, 80));
  if (typeof args.path === 'string') bits.push(args.path.slice(0, 80));
  if (typeof args.query === 'string') bits.push('q=' + args.query.slice(0, 80));
  if (typeof args.language === 'string') bits.push(args.language.slice(0, 20));
  return name + (bits.length ? ` (${bits.join(', ')})` : '');
}

// Detect project memory files at a root (presence only — content untouched).
const MEMORY_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
export function detectMemoryFiles(root) {
  try { return MEMORY_FILES.filter((n) => existsSync(join(root, n))); }
  catch { return []; }
}

// Pure dispatch layer: (JSON-RPC request object) -> (JSON-RPC response object,
// or null for notifications). All effects go through the injected store,
// session log, executor, fetch, memory-probe, and clock — no stdio, no ambient
// state. `memoryProbe` defaults to none so the pure layer stays deterministic.
export function createDispatcher({
  store = new RuntimeStore(':memory:'),
  session = null,
  execute = executeScript,
  fetch = fetchUrl,
  memoryProbe = () => [],
  now = () => 0,
} = {}) {
  const log = session ?? new SessionLog(store);

  async function callTool(name, args) {
    switch (name) {
      case 'eap_execute':
        return execute(requireString(args, 'script'), {
          language: args.language ?? 'python3',
          timeoutMs: args.timeoutMs,
          intent: args.intent,
          store,
          createdAt: now(),
        });
      case 'eap_execute_file':
        return executeFile(requireString(args, 'path'), {
          language: args.language,
          timeoutMs: args.timeoutMs,
          intent: args.intent,
          store,
          createdAt: now(),
        });
      case 'eap_batch_execute':
        return executeBatch(args.scripts, { store, createdAt: now() });
      case 'eap_index':
        return store.index(requireString(args, 'source'), requireString(args, 'content'), { createdAt: now() });
      case 'eap_search':
        return { hits: store.search(requireString(args, 'query'), { limit: args.limit ?? 5, docId: args.docId ?? null }) };
      case 'eap_fetch': {
        const res = await fetch(requireString(args, 'url'), { timeoutMs: args.timeoutMs, maxBytes: args.maxBytes, now });
        if (res.error) return res; // ssrf-blocked / scheme-blocked / fetch-failed / bad-url
        const off = store.offload(`eap_fetch:${res.finalUrl}`, res.text, { createdAt: now() });
        const head = {
          ok: res.ok, status: res.status, url: res.url, finalUrl: res.finalUrl,
          contentType: res.contentType, bytes: res.bytes, truncated: res.truncated, cached: res.cached,
        };
        return off.inline
          ? { ...head, offloaded: false, text: off.body }
          : { ...head, offloaded: true, pointer: off.pointer, hint: off.hint };
      }
      case 'eap_fetch_and_index': {
        const res = await fetch(requireString(args, 'url'), { timeoutMs: args.timeoutMs, maxBytes: args.maxBytes, now });
        if (res.error) return res;
        const p = store.index(`eap_fetch:${res.finalUrl}`, res.text, { createdAt: now() });
        const vocab = store.vocabulary(p.id, { limit: 15 });
        return {
          ok: res.ok, status: res.status, finalUrl: res.finalUrl, contentType: res.contentType,
          bytes: res.bytes, truncated: res.truncated, pointer: p.id, chunks: p.chunks,
          vocabulary: vocab,
          hint: `Indexed ${p.chunks} section(s) from ${res.finalUrl}. ` +
            `Query with eap_search(query, { docId: "${p.id}" }).` +
            (vocab.length ? ` Terms: ${vocab.slice(0, 10).join(', ')}.` : ''),
        };
      }
      case 'eap_stats':
        return store.stats();
      case 'eap_offload':
        return store.offload(requireString(args, 'source'), requireString(args, 'content'), {
          threshold: args.threshold,
          createdAt: now(),
        });
      case 'eap_purge':
        return store.purge({ docId: args.docId ?? null });
      case 'eap_doctor':
        return {
          ok: true,
          node: process.version,
          platform: process.platform,
          sqlite: probeSqlite(),
          runtimes: runtimeAvailability(),
          store: store.health(),
        };
      case 'eap_session_snapshot':
        return log.snapshot({ ts: args.ts ?? now(), maxBytes: args.maxBytes });
      case 'eap_session_restore':
        return log.restore({ memoryFiles: memoryProbe() });
      default:
        throw new Error(`unhandled tool: ${name}`);
    }
  }

  return async function dispatch(msg) {
    const hasId = msg !== null && typeof msg === 'object' && msg.id !== undefined && msg.id !== null;
    const id = hasId ? msg.id : null;
    const reply = (payload) => (hasId ? { jsonrpc: '2.0', id, ...payload } : null);

    if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    }
    const method = msg.method;
    const params = msg.params ?? {};

    try {
      if (method === 'initialize') {
        return reply({
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: SERVER_INFO,
            capabilities: { tools: {} },
          },
        });
      }
      if (method === 'ping') return reply({ result: {} });
      if (method === 'tools/list') return reply({ result: { tools: TOOLS } });
      if (method.startsWith('notifications/')) return null;

      if (method === 'tools/call') {
        const name = params.name;
        const args = params.arguments ?? {};
        if (!TOOLS.some((t) => t.name === name)) {
          return reply({ error: { code: -32602, message: `Unknown tool: ${String(name)}` } });
        }
        try {
          const value = await callTool(name, args);
          // Session continuity: every tool call is logged (DESIGN.md move 3).
          log.append({ ts: now(), kind: 'tool', summary: summarizeCall(name, args) });
          return reply({
            result: {
              content: [{ type: 'text', text: JSON.stringify(value) }],
              structuredContent: value,
              isError: false,
            },
          });
        } catch (err) {
          log.append({ ts: now(), kind: 'error', summary: `${name}: ${err.message}` });
          // MCP convention: tool execution failures are results with isError,
          // not protocol-level errors.
          return reply({
            result: {
              content: [{ type: 'text', text: `Error: ${err.message}` }],
              isError: true,
            },
          });
        }
      }

      return reply({ error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (err) {
      return reply({ error: { code: -32603, message: `Internal error: ${err.message}` } });
    }
  };
}

// Parse one raw input line and dispatch it. Malformed JSON yields a JSON-RPC
// parse error (-32700) with id null, per the JSON-RPC 2.0 spec.
export async function dispatchLine(dispatch, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  return dispatch(msg);
}

function defaultDbPath() {
  const fromEnv = process.env.EAP_DB;
  if (fromEnv === ':memory:') return fromEnv;
  if (fromEnv) {
    mkdirSync(dirname(fromEnv), { recursive: true });
    return fromEnv;
  }
  const dir = join(process.cwd(), '.eap');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'runtime.db');
}

// Wire the pure dispatcher to a newline-delimited stdio loop. Responses are
// written in request order (a promise chain serializes the async handlers).
export function serve({
  dbPath = defaultDbPath(),
  input = process.stdin,
  output = process.stdout,
  now = () => Date.now(), // the only clock read; injected into the pure layer
  root = process.cwd(),
} = {}) {
  const store = new RuntimeStore(dbPath);
  const session = new SessionLog(store);
  const dispatch = createDispatcher({ store, session, now, memoryProbe: () => detectMemoryFiles(root) });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      const res = await dispatchLine(dispatch, line);
      if (res) output.write(JSON.stringify(res) + '\n');
    });
  });
  rl.on('close', () => {
    queue.then(() => store.close());
  });
  return { store, session, dispatch, rl };
}

if (process.argv[1] && process.argv[1] === import.meta.filename) {
  serve();
}
