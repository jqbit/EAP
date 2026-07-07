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
//   eap_index              chunk + index content behind a searchable pointer
//   eap_search             lossless chunk retrieval from the FTS store
//   eap_stats              measured bytes kept out of context
//   eap_offload            inline-or-pointer decision for arbitrary content
//   eap_session_snapshot   priority-tiered <=2KB snapshot (PreCompact)
//   eap_session_restore    return the persisted snapshot (SessionStart)
//
// The dispatch layer (createDispatcher) is a pure function of its injected
// store/session/executor/clock — testable without a live stdio loop.
//
// Zero third-party dependencies: node:readline, node:fs, node:path + siblings.

import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RuntimeStore } from './store.mjs';
import { SessionLog } from './session.mjs';
import { executeScript } from './executor.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'eap-runtime', version: '0.1.0' };

export const TOOLS = [
  {
    name: 'eap_execute',
    description: 'Run a short script in a subprocess (python3 | node | bash). Only printed stdout returns to context; oversized stdout is indexed and a searchable pointer is returned instead. Network calls are refused by policy — use eap_fetch for URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Script source to run.' },
        language: { type: 'string', enum: ['python3', 'python', 'node', 'javascript', 'js', 'bash', 'sh'], default: 'python3' },
        timeoutMs: { type: 'number', description: 'Wall-clock timeout in ms.' },
      },
      required: ['script'],
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
    description: 'Query the full-text store; returns exact matching chunks (lossless) with source spans, never summaries.',
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
    name: 'eap_stats',
    description: 'Report measured bytes kept out of context (a real sum of indexed bytes, not a modeled percentage).',
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
    name: 'eap_session_snapshot',
    description: 'Build and persist a compact priority-tiered session snapshot (<= ~2KB). Call at PreCompact.',
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
    description: 'Return the last persisted session snapshot (or null). Call at SessionStart.',
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
  if (typeof args.query === 'string') bits.push('q=' + args.query.slice(0, 80));
  if (typeof args.language === 'string') bits.push(args.language.slice(0, 20));
  return name + (bits.length ? ` (${bits.join(', ')})` : '');
}

// Pure dispatch layer: (JSON-RPC request object) -> (JSON-RPC response object,
// or null for notifications). All effects go through the injected store,
// session log, executor, and clock — no stdio, no ambient state.
export function createDispatcher({
  store = new RuntimeStore(':memory:'),
  session = null,
  execute = executeScript,
  now = () => 0,
} = {}) {
  const log = session ?? new SessionLog(store);

  async function callTool(name, args) {
    switch (name) {
      case 'eap_execute':
        return execute(requireString(args, 'script'), {
          language: args.language ?? 'python3',
          timeoutMs: args.timeoutMs,
          store,
          createdAt: now(),
        });
      case 'eap_index':
        return store.index(requireString(args, 'source'), requireString(args, 'content'), { createdAt: now() });
      case 'eap_search':
        return { hits: store.search(requireString(args, 'query'), { limit: args.limit ?? 5, docId: args.docId ?? null }) };
      case 'eap_stats':
        return store.stats();
      case 'eap_offload':
        return store.offload(requireString(args, 'source'), requireString(args, 'content'), {
          threshold: args.threshold,
          createdAt: now(),
        });
      case 'eap_session_snapshot':
        return log.snapshot({ ts: args.ts ?? now(), maxBytes: args.maxBytes });
      case 'eap_session_restore':
        return log.restore();
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
} = {}) {
  const store = new RuntimeStore(dbPath);
  const session = new SessionLog(store);
  const dispatch = createDispatcher({ store, session, now });
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
