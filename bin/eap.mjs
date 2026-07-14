#!/usr/bin/env node
// EAP — unified CLI dispatcher.
//
//   eap update | install | uninstall | list | doctor | help
//
// The legacy `eap-install` bin still points at bin/eap-install.mjs unchanged.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_BIN = path.join(__dirname, 'eap-install.mjs');

function runNode(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit',
    cwd: opts.cwd || REPO_ROOT,
    env: process.env,
  });
  if (r.error) {
    process.stderr.write(String(r.error.message || r.error) + '\n');
    return 1;
  }
  return r.status == null ? 1 : r.status;
}

function printHelp() {
  process.stdout.write(`eap — Efficient Agent Protocol CLI

USAGE
  eap <command> [args]

COMMANDS
  update [opts]     Fetch GitHub 0point9bar/EAP, refresh checkout, re-run installer
  install [flags]   Wire EAP layers into your agent(s)  (→ eap-install)
  uninstall [flags] Remove EAP wiring                   (→ eap-install --uninstall)
  list              Provider matrix                     (→ eap-install --list)
  doctor            Runtime health check (store, sqlite, hooks, runtimes)
  help              Show this help

EXAMPLES
  eap update
  eap update --check
  eap update --dry-run
  eap update --ref v0.2.0
  eap install --only claude --non-interactive
  eap uninstall
  eap list
  eap doctor

Legacy: eap-install (same as \`eap install\`).
`);
}

async function cmdDoctor() {
  try {
    const { runDoctor } = await import(
      path.join(REPO_ROOT, 'layers', 'eap-runtime', 'src', 'doctor.mjs')
    );
    let store = null;
    try {
      const { RuntimeStore } = await import(
        path.join(REPO_ROOT, 'layers', 'eap-runtime', 'src', 'store.mjs')
      );
      store = new RuntimeStore();
    } catch { /* doctor still useful without a store */ }
    try {
      const report = runDoctor({ store });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return report.ok ? 0 : 1;
    } finally {
      if (store && typeof store.close === 'function') store.close();
    }
  } catch (e) {
    process.stderr.write(`eap doctor unavailable: ${e.message || e}\n`);
    process.stderr.write('hint: ensure this checkout includes layers/eap-runtime\n');
    return 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printHelp();
    return 0;
  }

  switch (cmd) {
    case 'update': {
      const { runUpdateCli } = await import(path.join(__dirname, 'lib', 'update.mjs'));
      return runUpdateCli(rest, {
        repoRoot: REPO_ROOT,
        installBin: INSTALL_BIN,
      });
    }
    case 'install':
      return runNode(INSTALL_BIN, rest);
    case 'uninstall':
      return runNode(INSTALL_BIN, ['--uninstall', ...rest]);
    case 'list':
      return runNode(INSTALL_BIN, ['--list', ...rest]);
    case 'doctor':
      return cmdDoctor();
    default:
      process.stderr.write(`error: unknown command: ${cmd}\nrun 'eap help'\n`);
      return 2;
  }
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
