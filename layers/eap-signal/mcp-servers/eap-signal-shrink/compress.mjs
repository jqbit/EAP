// eap-signal-shrink — pure-Node prose compressor for MCP tool descriptions.
// Adapted from TLDR tldr-shrink (MIT). Boundaries: preserve code, URLs, paths,
// identifiers; strip articles/filler/hedging/pleasantries from prose fields.

const FILLERS = new RegExp(
  '\\b(?:just|really|basically|actually|simply|quite|very|essentially|literally)\\b',
  'gi'
);

const PLEASANTRIES = new RegExp(
  '\\b(?:please|kindly|thank you|thanks|sure|certainly|of course|happy to|i\'?d be happy)\\b[,.]?\\s*',
  'gi'
);

const HEDGES = new RegExp(
  '\\b(?:perhaps|maybe|might|could potentially|would like to|i think|in my opinion|it seems|it appears)\\b\\s*',
  'gi'
);

const LEADERS = new RegExp(
  '^(?:i\'?ll|i will|i can|i\'?d|you can|we will|we can|let me|let\'?s)\\s+',
  'gim'
);

const ARTICLES = /\b(?:a|an|the)\s+(?=[a-z])/gi;

const PROTECTED_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /\bhttps?:\/\/\S+/gi,
  /\b[\w.-]*[\/\\][\w.\/\\\-]+/g,
  /\b[A-Z][A-Za-z0-9]*(?:_[A-Z][A-Za-z0-9]*)+\b/g,
  /\b\w+\.\w+(?:\.\w+)*\(\)?/g,
  /[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/g,
  /\b\d+\.\d+\.\d+\b/g,
];

export function withProtectedSegments(text, transform) {
  const segments = [];
  let working = text;
  for (const re of PROTECTED_PATTERNS) {
    working = working.replace(re, (m) => {
      const i = segments.length;
      segments.push(m);
      return `\x00${i}\x00`;
    });
  }
  // Use NUL-delimited sentinels so nested restores cannot collide with digits in prose.
  let out = transform(working);
  let prev;
  let guard = 0;
  do {
    prev = out;
    out = out.replace(/\x00(\d+)\x00/g, (_, i) => segments[+i] ?? '');
  } while (out !== prev && ++guard < segments.length + 2);
  return out;
}

function compressProse(text) {
  let s = text;
  s = s.replace(LEADERS, '');
  s = s.replace(PLEASANTRIES, '');
  s = s.replace(HEDGES, '');
  s = s.replace(FILLERS, '');
  s = s.replace(ARTICLES, '');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/\s+([,.;:!?])/g, '$1');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
  return s.trim();
}

export function compress(text, _opts) {
  if (typeof text !== 'string' || text.length === 0) {
    return { compressed: text, before: 0, after: 0 };
  }
  const before = text.length;
  const compressed = withProtectedSegments(text, compressProse);
  return { compressed, before, after: compressed.length };
}

export function compressDescriptionsInPlace(obj, fieldNames) {
  const fields = new Set(fieldNames || ['description']);
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) compressDescriptionsInPlace(item, [...fields]);
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (fields.has(key) && typeof val === 'string') {
      obj[key] = compress(val).compressed;
    } else if (val && typeof val === 'object') {
      compressDescriptionsInPlace(val, [...fields]);
    }
  }
}
