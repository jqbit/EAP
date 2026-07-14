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
//   eap_batch_execute      scripts and/or searches; optional concurrency 1–8
//   eap_index              chunk + index content behind a searchable pointer
//   eap_search             lossless retrieval (+ multi-query, filters, fuzzy, stale)
//   eap_fetch              SSRF-hardened URL fetch; reduced text, auto-offloaded
//   eap_fetch_and_index    fetch + index (+ TTL, force, parallel requests[])
//   eap_stats              measured bytes kept out of context + token estimate
//   eap_report             local measured summary (docs/bytes/kinds; no $/%)
//   eap_offload            inline-or-pointer decision for arbitrary content
//   eap_purge              clear the store or a single document
//   eap_doctor             self-check: version, hooks, runtimes, sqlite, store
//   eap_upgrade            safe-core self-update: version + pinned release tag + store migrate + doctor + apply plan
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
import { RuntimeStore, DEFAULT_INDEX_TTL_MS } from './store.mjs';
import { SessionLog } from './session.mjs';
import { executeScript, executeFile, executeBatch } from './executor.mjs';
import { fetchUrl } from './fetch.mjs';
import { indexPath } from './indexdir.mjs';
import { upgrade as runUpgrade } from './upgrade.mjs';
import { runDoctor } from './doctor.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'eap-runtime', version: '0.3.0' };

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
    description: 'Run several scripts and/or searches (bounded to 20). Optional concurrency 1–8. Each item is either a script { script, language?, timeoutMs?, intent? } or a search { query|queries, search:true, limit?, docId?, contentType? }.',
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
              search: { type: 'boolean', description: 'If true, treat as a store search instead of a script.' },
              type: { type: 'string', enum: ['script', 'search'] },
              query: { type: 'string' },
              queries: { type: 'array', items: { type: 'string' } },
              limit: { type: 'number' },
              docId: { type: 'string' },
              contentType: { type: 'string', enum: ['code', 'prose', 'all'] },
            },
          },
        },
        concurrency: { type: 'number', description: 'Parallelism 1–8 (default 1).' },
      },
      required: ['scripts'],
    },
  },
  {
    name: 'eap_index',
    description: 'Chunk and index content into the local full-text store. Either pass source+content (inline blob), or pass `path` (a file or directory): a directory is walked (binaries skipped, .git/node_modules/.eap excluded, bounded by max files and a per-file byte cap — truncation is reported) and each text file is indexed. Returns pointer descriptor(s).',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Label for the content origin (e.g. a path). Required with `content`.' },
        content: { type: 'string', description: 'Inline content to index. Required unless `path` is given.' },
        path: { type: 'string', description: 'File or directory to index instead of inline content.' },
        maxFiles: { type: 'number', description: 'Directory walk bound (default 200).' },
        maxFileBytes: { type: 'number', description: 'Per-file byte cap (default 262144); larger files are truncated and flagged.' },
      },
    },
  },
  {
    name: 'eap_search',
    description: 'Query the full-text store; returns exact matching chunks (lossless, RRF-fused keyword+substring) with source spans and a locator snippet, never summaries. Supports contentType filter, multi-query (queries[]), proximity rerank, fuzzy correction on zero hits, optional progressive throttle, and stale flags for path-tracked docs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Primary query (optional when queries[] is set).' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Multi-query fusion in one call.' },
        limit: { type: 'number', default: 5 },
        docId: { type: 'string', description: 'Restrict to one indexed document.' },
        contentType: { type: 'string', enum: ['code', 'prose', 'all'], description: 'Filter chunks by heuristic kind.' },
        fuzzy: { type: 'boolean', description: 'Edit-distance correction when zero hits (default true).' },
        proximity: { type: 'boolean', description: 'Multi-term proximity rerank (default true).' },
        throttle: { type: ['boolean', 'number', 'string'], description: 'Optional progressive throttle (true|ms); or set EAP_SEARCH_THROTTLE=1.' },
        checkStale: { type: 'boolean', description: 'Flag path-tracked hits when file hash changed (default true).' },
      },
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
    description: 'Fetch an http/https URL (same SSRF hardening as eap_fetch), reduce HTML to text, index it, and return a searchable pointer + a term vocabulary — never the raw body. Supports TTL (default 24h; ttl:0 disables), force re-fetch/re-index, and parallel multi-URL via requests[] (concurrency 1–8). Expired docs are cleaned before index.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Single URL (optional when requests[] is set).' },
        requests: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              timeoutMs: { type: 'number' },
              maxBytes: { type: 'number' },
              ttl: { type: 'number', description: 'TTL ms for this URL; 0 = no expiry.' },
              force: { type: 'boolean' },
            },
            required: ['url'],
          },
          description: 'Parallel multi-URL fetch+index (concurrency 1–8).',
        },
        timeoutMs: { type: 'number' },
        maxBytes: { type: 'number' },
        ttl: { type: 'number', description: 'Index TTL in ms (default 24h). Pass 0 for no expiry.' },
        force: { type: 'boolean', description: 'Bypass fetch TTL cache and re-index.' },
        concurrency: { type: 'number', description: 'Parallelism for requests[] (1–8, default 4).' },
      },
    },
  },
  {
    name: 'eap_stats',
    description: 'Report measured bytes kept out of context (a real sum of indexed bytes) plus an estimated token count (~bytes/4 heuristic, labelled — not a modeled percentage, no dollar figure).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'eap_report',
    description: 'Local measured store summary: docs/chunks/bytesKeptOut, by-kind breakdown, expired and path-tracked counts. Measured values only — never dollar or percentage savings claims. Not a hosted SaaS product.',
    inputSchema: {
      type: 'object',
      properties: {
        now: { type: 'number', description: 'Injected clock for expiry accounting (defaults to server clock).' },
      },
    },
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
    description: 'Self-check: runtime version, node >= 22, language-runtime availability, node:sqlite + FTS5/trigram, store integrity, and best-effort hook registration. Never falls back to better-sqlite3.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'eap_upgrade',
    description: 'Self-update, safe core: report the current EAP version, resolve the target release tag (explicit tag or the latest vX.Y.Z/RELEASE-* tag via git ls-remote — never a mutable branch), migrate + integrity-check the .eap/ store, re-run doctor, and return the pinned-tag apply plan. Nothing is fetched or executed: no checksum manifest exists yet, so auto-apply is refused rather than pulling unverified code.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Explicit release tag (vX.Y.Z or RELEASE-*). Omit to resolve the latest from the remote.' },
      },
    },
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
  upgrade = runUpgrade,
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
        return executeBatch(args.scripts, {
          store, createdAt: now(), concurrency: args.concurrency ?? 1,
        });
      case 'eap_index':
        if (typeof args.path === 'string' && args.path) {
          return indexPath(store, args.path, {
            maxFiles: args.maxFiles, maxFileBytes: args.maxFileBytes, createdAt: now(),
          });
        }
        return store.index(requireString(args, 'source'), requireString(args, 'content'), { createdAt: now() });
      case 'eap_search': {
        const hasQueries = Array.isArray(args.queries) && args.queries.length > 0;
        const q = typeof args.query === 'string' ? args.query : '';
        if (!hasQueries && !q.trim()) throw new Error('missing required string argument "query" (or non-empty queries[])');
        const hits = store.search(q, {
          limit: args.limit ?? 5,
          docId: args.docId ?? null,
          queries: hasQueries ? args.queries : null,
          contentType: args.contentType ?? null,
          fuzzy: args.fuzzy !== false,
          proximity: args.proximity !== false,
          throttle: args.throttle ?? false,
          checkStale: args.checkStale !== false,
        });
        return { hits };
      }
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
        store.purgeExpired({ now: now() });
        const reqs = Array.isArray(args.requests) && args.requests.length
          ? args.requests
          : [{ url: requireString(args, 'url'), timeoutMs: args.timeoutMs, maxBytes: args.maxBytes, ttl: args.ttl, force: args.force }];
        if (reqs.length > 20) throw new Error('eap_fetch_and_index requests[] capped at 20');
        const conc = Math.max(1, Math.min(8, Number(args.concurrency) || (reqs.length > 1 ? 4 : 1)));
        const defaultTtl = args.ttl === 0 ? 0 : (Number.isFinite(args.ttl) ? args.ttl : DEFAULT_INDEX_TTL_MS);

        async function one(req) {
          const url = typeof req.url === 'string' ? req.url : '';
          if (!url) return { ok: false, error: 'bad-url', reason: 'missing url' };
          const force = req.force === true || args.force === true;
          const ttl = req.ttl === 0 ? 0 : (Number.isFinite(req.ttl) ? req.ttl : defaultTtl);
          const final = await fetch(url, {
            timeoutMs: req.timeoutMs ?? args.timeoutMs,
            maxBytes: req.maxBytes ?? args.maxBytes,
            now,
            cache: force ? null : undefined,
          });
          if (final.error) return final;
          const ts = now();
          const p = store.index(`eap_fetch:${final.finalUrl}`, final.text, {
            createdAt: ts,
            now: ts,
            ttlMs: ttl,
          });
          const vocab = store.vocabulary(p.id, { limit: 15 });
          return {
            ok: final.ok, status: final.status, finalUrl: final.finalUrl, contentType: final.contentType,
            bytes: final.bytes, truncated: final.truncated, cached: final.cached,
            pointer: p.id, chunks: p.chunks, expiresAt: p.expiresAt, vocabulary: vocab,
            hint: `Indexed ${p.chunks} section(s) from ${final.finalUrl}. ` +
              `Query with eap_search(query, { docId: "${p.id}" }).` +
              (vocab.length ? ` Terms: ${vocab.slice(0, 10).join(', ')}.` : ''),
          };
        }

        if (reqs.length === 1) return one(reqs[0]);
        // Bounded parallel pool
        const results = new Array(reqs.length);
        let cursor = 0;
        async function worker() {
          while (cursor < reqs.length) {
            const i = cursor++;
            results[i] = await one(reqs[i]);
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc, reqs.length) }, () => worker()));
        return { ok: results.every((r) => r && r.ok !== false && !r.error), count: results.length, concurrency: conc, results };
      }
      case 'eap_stats':
        return store.stats();
      case 'eap_report':
        return store.report({ now: Number.isFinite(args.now) ? args.now : now() });
      case 'eap_offload':
        return store.offload(requireString(args, 'source'), requireString(args, 'content'), {
          threshold: args.threshold,
          createdAt: now(),
        });
      case 'eap_purge':
        return store.purge({ docId: args.docId ?? null });
      case 'eap_doctor':
        return runDoctor({ store });
      case 'eap_upgrade':
        return upgrade({
          tag: typeof args.tag === 'string' && args.tag ? args.tag : null,
          store,
          doctor: () => callTool('eap_doctor', {}),
        });
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
