# Security Policy

## Supported Versions

Only the `main` branch is supported.

## Reporting a Vulnerability

- **Sensitive issues:** please use [GitHub security advisories](https://github.com/jqbit/EAP/security/advisories/new).
- **Non-sensitive issues:** open a regular [issue](https://github.com/jqbit/EAP/issues).

Target response time: **within 7 days** for valid vulnerability reports. Best-effort, not a paid-support SLA.

## Attack surface

EAP has three layers and a self-contained installer. The security-relevant surfaces are:

1. **Installers** — `install.sh` (`curl | bash`), `install.ps1` (`irm | iex`), and `bin/eap-install.mjs`. Inspect them before running.
2. **EAP-Runtime** (`layers/eap-runtime/`) — an MCP server whose `eap_execute` tool runs a script in a subprocess. It is a **policy control (network deny-list), not an OS sandbox**; it inherits host credentials. Timeouts and output are bounded; OS resource isolation is an explicit later layer. See `layers/eap-runtime/DESIGN.md` → "Security (stated honestly)".
3. **EAP-Context** (`layers/eap-context/`) — an MCP server that indexes a code tree. It refuses out-of-tree symlinks, validates the on-disk cache as untrusted input (in-tree relative paths + integer line numbers only), confines the build root, and validates every MCP parameter at the boundary.

## Posture

EAP states its security honestly (see the DESIGN docs). Known, bounded limitations are documented rather than hidden. The engines are **zero third-party dependency** (Node built-ins + Python stdlib), which keeps the supply-chain surface at zero. Every hardening fix carries a regression test.

**Please inspect the installers and the two MCP servers before running.**
