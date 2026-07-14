// EAP-Runtime — eap_upgrade: pinned-tag self-update, SAFE CORE (clean-room).
//
// What this does today (deliberately): version check, release-tag resolution
// against the git remote (explicit tag or latest release tag — NEVER mutable
// main/master), an idempotent .eap/ store schema migrate + integrity check, a
// doctor re-run, and a *plan* of the exact commands to apply the update.
//
// What it does NOT do: fetch or execute updated code. This repo currently has
// no checksum manifest (no checksums.sha256 machinery exists), so there is no
// way to verify fetched code before running it. Auto-applying would mean
// pulling unverified code — refused by design. When a signed/checksummed
// release artifact lands, the apply step slots in behind verifyPlan().
//
// Node built-ins only; git interaction is injected for testability.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A release tag: vX.Y.Z / X.Y.Z (optional pre-release suffix) or RELEASE-*.
const TAG_RE = /^(v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?|RELEASE-[0-9A-Za-z._-]+)$/;
const FORBIDDEN = new Set(['main', 'master', 'HEAD', 'trunk', 'develop']);

export function isReleaseTag(tag) {
  return typeof tag === 'string' && !FORBIDDEN.has(tag) && TAG_RE.test(tag);
}

// Parse `git ls-remote --tags` output into tag names (peeled ^{} dropped).
export function parseLsRemoteTags(text) {
  return String(text).split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((r) => r && r.startsWith('refs/tags/') && !r.endsWith('^{}'))
    .map((r) => r.slice('refs/tags/'.length));
}

// Numeric-aware semver-ish compare for vX.Y.Z tags.
function semverKey(tag) {
  const m = String(tag).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Pick the highest release tag from a list; null when none qualifies.
export function latestReleaseTag(tags) {
  const candidates = tags.filter(isReleaseTag);
  const semver = candidates.map((t) => ({ t, k: semverKey(t) })).filter((x) => x.k);
  if (semver.length) {
    semver.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
    return semver[semver.length - 1].t;
  }
  // RELEASE-* only: lexicographically last (deterministic).
  return candidates.sort().pop() ?? null;
}

// Resolve the target tag. `tag` explicit wins (validated); otherwise the latest
// release tag from `lsRemote()` (injected; defaults to real git ls-remote).
export function resolveReleaseTag(tag, { lsRemote = defaultLsRemote, remote = 'origin' } = {}) {
  if (tag != null && tag !== '') {
    if (!isReleaseTag(tag)) {
      return { error: 'invalid-tag', message: `"${tag}" is not a release tag (vX.Y.Z or RELEASE-*). Mutable refs (main/master/HEAD) are refused.` };
    }
    return { tag, source: 'explicit' };
  }
  let out;
  try { out = lsRemote(remote); }
  catch (e) { return { error: 'ls-remote-failed', message: `git ls-remote --tags ${remote} failed: ${e.message}` }; }
  const latest = latestReleaseTag(parseLsRemoteTags(out));
  if (!latest) return { error: 'no-release-tags', message: `No release tags (vX.Y.Z / RELEASE-*) found on ${remote}.` };
  return { tag: latest, source: 'latest-remote' };
}

function defaultLsRemote(remote) {
  return execFileSync('git', ['ls-remote', '--tags', remote], {
    cwd: repoRoot(), encoding: 'utf8', timeout: 30_000,
  });
}

function repoRoot() {
  // layers/eap-runtime/src/upgrade.mjs -> repo root is three levels up.
  return join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
}

export function currentVersion(root = repoRoot()) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null; }
  catch { return null; }
}

// The safe core. Injected deps: store (for the migrate + integrity check),
// doctor (async () => report), lsRemote. Never mutates the working tree.
export async function upgrade({ tag = null, store = null, doctor = null, lsRemote, remote = 'origin', version = currentVersion() } = {}) {
  const resolved = resolveReleaseTag(tag, lsRemote ? { lsRemote, remote } : { remote });
  if (resolved.error) return { ok: false, ...resolved, currentVersion: version };

  // Store migrate: opening via RuntimeStore/SessionLog constructors is the
  // schema migration for the current schema (CREATE TABLE IF NOT EXISTS is
  // idempotent); then verify integrity.
  let storeHealth = null;
  if (store) { try { storeHealth = store.health(); } catch (e) { storeHealth = { ok: false, error: e.message }; } }

  let doctorReport = null;
  if (doctor) { try { doctorReport = await doctor(); } catch (e) { doctorReport = { ok: false, error: e.message }; } }

  return {
    ok: true,
    applied: false, // safe core: plan only, nothing fetched or executed
    currentVersion: version,
    targetTag: resolved.tag,
    tagSource: resolved.source,
    storeHealth,
    doctor: doctorReport,
    verification: 'unavailable — no checksum manifest (checksums.sha256) exists in this release channel yet; '
      + 'MCP auto-apply is refused rather than pulling unverified code. '
      + 'CLI `eap update` applies because the operator typed it (explicit consent).',
    plan: [
      `eap update --ref ${resolved.tag}   # recommended: CLI apply (fetch + checkout + reinstall)`,
      `# or manually:`,
      `git -C <eap-repo> fetch --tags ${remote}`,
      `git -C <eap-repo> verify-tag ${resolved.tag}  # if the tag is signed; otherwise inspect it`,
      `git -C <eap-repo> checkout ${resolved.tag}  # pinned tag, never a mutable branch`,
      'node bin/eap-install.mjs --non-interactive  # rewire hooks/MCP',
      'eap doctor  # confirm store + runtimes are healthy after the switch',
    ],
  };
}

// ── CLI path: node layers/eap-runtime/src/upgrade.mjs [tag] ─────────────────
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2] || null;
  upgrade({ tag }).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.ok ? 0 : 1);
  });
}
