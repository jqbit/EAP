#!/usr/bin/env bash
# EAP — one-line installer for macOS, Linux, and Git Bash / WSL on Windows.
#
#   curl -fsSL https://raw.githubusercontent.com/0point9bar/EAP/main/install.sh | bash
#
# Pass installer flags after `-s --`, e.g. install only Claude Code:
#   curl -fsSL https://raw.githubusercontent.com/0point9bar/EAP/main/install.sh | bash -s -- --only claude
#
# Env overrides: EAP_HOME (checkout dir, default ~/.eap-src), EAP_REPO
# (owner/repo), EAP_BRANCH (default main), EAP_NONINTERACTIVE=1 (skip the TUI).
#
# This bootstrap: checks git + Node >=22, clones/updates the EAP repo, then runs
# the Node installer — which launches an interactive TUI on a terminal (it reads
# from /dev/tty so it works even through `curl | bash`), or takes flags in CI.
set -euo pipefail

REPO="${EAP_REPO:-0point9bar/EAP}"
BRANCH="${EAP_BRANCH:-main}"
EAP_HOME="${EAP_HOME:-$HOME/.eap-src}"

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  err "EAP needs '$1' but it is not installed."
  case "$1" in
    git)  warn "  macOS: xcode-select --install   Debian/Ubuntu: sudo apt install git   Windows: install Git for Windows";;
    node) warn "  Install Node.js >=22 from https://nodejs.org  (macOS: brew install node · Debian: sudo apt install nodejs · Windows: winget install OpenJS.NodeJS)";;
  esac
  exit 1
}

say "EAP installer — checking prerequisites"
need git
need node
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  err "EAP needs Node.js >= 22 (found $(node -v 2>/dev/null || echo none))."
  warn "  Upgrade Node (nvm install 22 · brew upgrade node · winget upgrade OpenJS.NodeJS) and re-run."
  exit 1
fi
command -v python3 >/dev/null 2>&1 || warn "  note: python3 not found — the EAP-Context graph layer needs it (Signal + Runtime still work; re-run with --no-context to skip)."

# Fetch or update the repo.
if [ -d "$EAP_HOME/.git" ]; then
  say "Updating EAP in $EAP_HOME"
  git -C "$EAP_HOME" pull --ff-only --quiet || warn "  (could not fast-forward; using existing checkout)"
else
  say "Cloning $REPO into $EAP_HOME"
  git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$EAP_HOME" \
    || { err "clone failed. If $REPO is private, either make it public or run from a local clone."; exit 1; }
fi

# Run the installer. Connect stdin to the terminal so the TUI works even when
# this script itself arrived over a pipe (curl | bash). Fall back to
# non-interactive when there is no terminal (CI) or EAP_NONINTERACTIVE is set.
INSTALLER="$EAP_HOME/bin/eap-install.mjs"
# Guard on whether /dev/tty can actually be OPENED, not on its permission bits.
# /dev/tty is mode 0666 so `-e`/`-r` are true even with no controlling terminal
# (CI, `docker run` without -t, cron); opening it there fails with ENXIO, which
# under `set -euo pipefail` would abort the whole install. The subshell open
# test in the `if` condition fails cleanly instead, routing to non-interactive.
if [ -z "${EAP_NONINTERACTIVE:-}" ] && ( : < /dev/tty ) 2>/dev/null; then
  node "$INSTALLER" "$@" < /dev/tty
else
  node "$INSTALLER" --non-interactive "$@"
fi
