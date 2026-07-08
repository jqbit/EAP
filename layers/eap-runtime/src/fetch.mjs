// EAP-Runtime — SSRF-hardened URL fetch + dependency-free HTML→text reducer.
//
// Closes the "broken promise" in executor.mjs and DESIGN.md: eap_execute refuses
// network egress and points callers at eap_fetch / eap_fetch_and_index. This is
// that allowlisted path. It is a POLICY control layered with real IP validation
// — NOT an OS sandbox (DESIGN.md "Security"). What it does guarantee:
//
//   • scheme allowlist: http/https only (no file:, ftp:, gopher:, data:, …);
//   • hard-block IMDS / link-local (169.254.0.0/16, incl. IPv4-mapped IPv6),
//     loopback (127/8, ::1), unspecified, private (10/8, 172.16/12, 192.168/16),
//     CGNAT, multicast, reserved/future, and their IPv6 equivalents;
//   • DNS-rebinding defence: the hostname is resolved ONCE, every resolved
//     address is validated, and the connection is *pinned* to the validated IP
//     via node's `lookup` option — DNS cannot rebind between check and connect;
//   • redirects are followed manually and EVERY hop is re-validated;
//   • a wall-clock timeout and a hard max-bytes cap bound the fetch;
//   • a small TTL cache dedupes repeat fetches within a window.
//
// Zero third-party dependencies: node:http, node:https, node:dns, node:url.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FETCH_TTL_MS = 60_000;
export const MAX_REDIRECTS = 5;
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
// Only the standard web ports. A non-default port (e.g. :6379 Redis, :22 SSH)
// is a strong SSRF signal even when the host itself passes the IP guard.
const ALLOWED_PORTS = new Set(['80', '443']);

// ── IP classification ────────────────────────────────────────────────────────

function ipv4ToInt(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return o[0] * 2 ** 24 + o[1] * 2 ** 16 + o[2] * 256 + o[3];
}

// [network-string, prefix-bits, reason] for IPv4. First match wins.
const V4_BLOCKS = [
  ['0.0.0.0', 8, 'this-host/reserved'],
  ['10.0.0.0', 8, 'private (10/8)'],
  ['100.64.0.0', 10, 'CGNAT (100.64/10)'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata (IMDS)'],
  ['172.16.0.0', 12, 'private (172.16/12)'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation (TEST-NET-1)'],
  ['192.168.0.0', 16, 'private (192.168/16)'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation (TEST-NET-2)'],
  ['203.0.113.0', 24, 'documentation (TEST-NET-3)'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved / future use'],
];

function classifyIPv4Int(n) {
  for (const [net, bits, reason] of V4_BLOCKS) {
    const base = ipv4ToInt(net);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) === (base & mask)) return reason;
  }
  return null;
}

// Parse an IPv6 literal (compression + embedded IPv4 tail supported) to 16 bytes.
function ipv6ToBytes(input) {
  let s = String(input).toLowerCase().split('%')[0]; // drop zone id
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return null;
  let head, tail;
  if (s.includes('::')) {
    const parts = s.split('::');
    if (parts.length > 2) return null;
    head = parts[0] ? parts[0].split(':') : [];
    tail = parts[1] ? parts[1].split(':') : [];
  } else {
    head = s.split(':');
    tail = [];
  }
  const expand = (arr) => {
    const out = [];
    for (const g of arr) {
      if (g.includes('.')) {
        const v4 = ipv4ToInt(g);
        if (v4 == null) return null;
        out.push(((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
      } else {
        out.push(g);
      }
    }
    return out;
  };
  head = expand(head); tail = expand(tail);
  if (!head || !tail) return null;
  const total = head.length + tail.length;
  const groups = s.includes('::')
    ? [...head, ...Array(8 - total).fill('0'), ...tail]
    : head;
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  return bytes;
}

function classifyIPv6Bytes(b) {
  const allZeroTo = (end) => b.slice(0, end).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): re-check the
  // embedded IPv4 so ::ffff:169.254.169.254 is blocked like 169.254.169.254.
  if (allZeroTo(10) && b[10] === 0xff && b[11] === 0xff) {
    const v4 = b[12] * 2 ** 24 + b[13] * 2 ** 16 + b[14] * 256 + b[15];
    return classifyIPv4Int(v4) || 'IPv4-mapped';
  }
  if (allZeroTo(12)) {
    if (b.every((x) => x === 0)) return 'unspecified (::)';
    if (b[15] === 1 && b.slice(12, 15).every((x) => x === 0)) return 'loopback (::1)';
    const v4 = b[12] * 2 ** 24 + b[13] * 2 ** 16 + b[14] * 256 + b[15];
    return classifyIPv4Int(v4) || 'IPv4-compatible';
  }
  // NAT64 (64:ff9b::/96) embeds an IPv4 address in the low 32 bits.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    const v4 = b[12] * 2 ** 24 + b[13] * 2 ** 16 + b[14] * 256 + b[15];
    return classifyIPv4Int(v4) || 'NAT64';
  }
  if ((b[0] & 0xfe) === 0xfc) return 'unique-local (fc00::/7)';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local (fe80::/10)';
  if (b[0] === 0xff) return 'multicast (ff00::/8)';
  return null;
}

// Decide whether a resolved address string is safe to connect to.
// -> { blocked: boolean, reason: string|null, family: 4|6|0 }
export function assessHostIp(ip) {
  const s = String(ip);
  const v4 = ipv4ToInt(s);
  if (v4 != null) {
    const reason = classifyIPv4Int(v4);
    return { blocked: !!reason, reason: reason || null, family: 4 };
  }
  const v6 = ipv6ToBytes(s);
  if (v6) {
    const reason = classifyIPv6Bytes(v6);
    return { blocked: !!reason, reason: reason || null, family: 6 };
  }
  // Not an IP literal we can classify — refuse rather than guess.
  return { blocked: true, reason: 'unparseable address', family: 0 };
}

// ── HTML → text reducer (minimal, dependency-free) ──────────────────────────

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, (m) => ENTITIES[m] ?? m);
}

function safeCodePoint(n) {
  try { return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
  catch { return ''; }
}

// Reduce an HTML document to readable plain text / lightweight markdown. Not a
// full parser: it strips script/style/comments, turns block elements into line
// breaks, renders links as "text (url)", list items as "- ", then removes the
// remaining tags and decodes a small set of entities.
export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, ' ');
  // Links: keep the destination alongside the anchor text.
  s = s.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => `${text} (${href})`);
  // Headings and list items get markers.
  s = s.replace(/<h[1-6]\b[^>]*>/gi, '\n\n# ').replace(/<\/h[1-6]>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  // Block-level closers and <br> become newlines.
  s = s.replace(/<\/(p|div|section|article|tr|ul|ol|table|pre|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ''); // drop every remaining tag
  s = decodeEntities(s);
  // Normalise whitespace: trim each line, collapse >2 blank lines.
  s = s.replace(/[ \t\f\v]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

// ── fetch ────────────────────────────────────────────────────────────────────

function promisedLookup(resolve, host) {
  // resolve: (host) => Promise<[{address, family}...]>. Default: node dns.lookup.
  if (resolve) return resolve(host);
  return new Promise((res, rej) => {
    dns.lookup(host, { all: true }, (err, addrs) => (err ? rej(err) : res(addrs)));
  });
}

// Validate a URL's host with the injected `guard` (default assessHostIp): for an
// IP literal, classify it directly; for a name, resolve and require EVERY
// resolved address to pass (conservative), then pin to the first safe one.
// -> { ok, pinIp, family, reason }
async function validateHost(urlObj, { guard, resolve }) {
  const host = urlObj.hostname.replace(/^\[|\]$/g, '');
  const literal = guard(host);
  if (literal.family !== 0) {
    return literal.blocked
      ? { ok: false, reason: `blocked host ${host}: ${literal.reason}` }
      : { ok: true, pinIp: host, family: literal.family || 4 };
  }
  // Hostname: resolve then validate every address.
  let addrs;
  try {
    addrs = await promisedLookup(resolve, host);
  } catch (e) {
    return { ok: false, reason: `DNS resolution failed for ${host}: ${e.code || e.message}` };
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    return { ok: false, reason: `no addresses resolved for ${host}` };
  }
  for (const a of addrs) {
    const v = guard(a.address);
    if (v.blocked) return { ok: false, reason: `blocked host ${host} -> ${a.address}: ${v.reason}` };
  }
  return { ok: true, pinIp: addrs[0].address, family: addrs[0].family };
}

// One HTTP(S) GET pinned to a validated IP. Never throws; resolves a result.
function requestOnce(urlObj, { pinIp, family, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const mod = urlObj.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const opts = {
      method: 'GET',
      headers: {
        'user-agent': 'eap-runtime-fetch/0.1',
        accept: 'text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5',
      },
      // Pin the connection to the pre-validated IP: DNS cannot rebind here.
      // Node's connect path invokes the custom lookup with `options.all=true`
      // (expects an array of {address,family}); honor both callback shapes so
      // hostname fetches work regardless of how the internals call us.
      lookup: (_h, _o, cb) =>
        _o && _o.all
          ? cb(null, [{ address: pinIp, family }])
          : cb(null, pinIp, family),
    };
    let req;
    try {
      req = mod.request(urlObj, opts, (res) => {
        const bufs = [];
        let bytes = 0;
        let truncated = false;
        res.on('data', (c) => {
          if (truncated) return;
          bytes += c.length;
          if (bytes > maxBytes) {
            truncated = true;
            bufs.push(c.subarray(0, Math.max(0, c.length - (bytes - maxBytes))));
            res.destroy();
          } else {
            bufs.push(c);
          }
        });
        res.on('end', () => done({
          status: res.statusCode, headers: res.headers,
          body: Buffer.concat(bufs), truncated,
        }));
        res.on('close', () => done({
          status: res.statusCode, headers: res.headers,
          body: Buffer.concat(bufs), truncated,
        }));
        res.on('error', (e) => done({ error: e.message }));
      });
    } catch (e) {
      done({ error: e.message });
      return;
    }
    const wall = setTimeout(() => { try { req.destroy(); } catch { /* noop */ } done({ error: 'wall-clock timeout', timedOut: true }); }, timeoutMs);
    if (wall.unref) wall.unref();
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* noop */ } });
    req.on('error', (e) => done({ error: e.message }));
    req.on('close', () => clearTimeout(wall));
    req.end();
  });
}

// Fetch a URL with SSRF hardening, redirect re-validation, byte cap, timeout, and
// a TTL cache. Returns a plain result object (never throws):
//   { ok:false, error, reason? }
//   { ok:true, status, url, finalUrl, contentType, bytes, truncated, text, cached }
const MODULE_CACHE = new Map();
export function clearFetchCache() { MODULE_CACHE.clear(); }

export async function fetchUrl(url, {
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxBytes = DEFAULT_FETCH_MAX_BYTES,
  maxRedirects = MAX_REDIRECTS,
  ttlMs = DEFAULT_FETCH_TTL_MS,
  now = () => Date.now(),
  cache = MODULE_CACHE,
  guard = assessHostIp,
  resolve = null,
  allowedPorts = ALLOWED_PORTS,
} = {}) {
  const startUrl = String(url ?? '');
  let urlObj;
  try {
    urlObj = new URL(startUrl);
  } catch {
    return { ok: false, error: 'bad-url', reason: `not a valid URL: ${startUrl}` };
  }
  if (!ALLOWED_SCHEMES.has(urlObj.protocol)) {
    return { ok: false, error: 'scheme-blocked', reason: `scheme "${urlObj.protocol}" not allowed (http/https only)` };
  }

  // TTL cache lookup (keyed by the requested URL).
  const cacheKey = urlObj.href;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > now()) return { ...hit.value, cached: true };
  }

  const clampedTimeout = Math.min(Math.max(1, Math.floor(Number(timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS)), 120_000);
  const clampedMax = Math.min(Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_FETCH_MAX_BYTES)), 32 * 1024 * 1024);

  let hops = 0;
  while (true) {
    if (!ALLOWED_SCHEMES.has(urlObj.protocol)) {
      return { ok: false, error: 'scheme-blocked', reason: `redirect to disallowed scheme "${urlObj.protocol}"` };
    }
    // Strip credentials so node cannot derive an `Authorization: Basic` header
    // (which would otherwise leak to the resolved IP, incl. across redirects).
    if (urlObj.username || urlObj.password) {
      urlObj.username = '';
      urlObj.password = '';
    }
    // Reject non-standard ports (empty port = scheme default = allowed).
    if (urlObj.port && !allowedPorts.has(urlObj.port)) {
      return { ok: false, error: 'port-blocked', reason: `port ${urlObj.port} not allowed (80/443 only)` };
    }
    const v = await validateHost(urlObj, { guard, resolve });
    if (!v.ok) return { ok: false, error: 'ssrf-blocked', reason: v.reason };

    const res = await requestOnce(urlObj, {
      pinIp: v.pinIp, family: v.family, timeoutMs: clampedTimeout, maxBytes: clampedMax,
    });
    if (res.error) return { ok: false, error: 'fetch-failed', reason: res.error, timedOut: !!res.timedOut };

    // Follow redirects manually, re-validating each hop.
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (++hops > maxRedirects) return { ok: false, error: 'too-many-redirects', reason: `exceeded ${maxRedirects} redirects` };
      try {
        urlObj = new URL(res.headers.location, urlObj);
      } catch {
        return { ok: false, error: 'bad-redirect', reason: `unparseable Location: ${res.headers.location}` };
      }
      continue;
    }

    const contentType = String(res.headers['content-type'] || '').toLowerCase();
    const rawText = res.body.toString('utf8');
    const isHtml = /text\/html|application\/xhtml/.test(contentType) || /^\s*<(!doctype|html)/i.test(rawText);
    const text = isHtml ? htmlToText(rawText) : rawText;

    const value = {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      url: startUrl,
      finalUrl: urlObj.href,
      contentType: contentType || 'application/octet-stream',
      bytes: res.body.length,
      truncated: res.truncated,
      text,
      cached: false,
    };
    if (cache && value.ok) cache.set(cacheKey, { expires: now() + ttlMs, value });
    return value;
  }
}
