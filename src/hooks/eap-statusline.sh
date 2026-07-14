#!/usr/bin/env bash
# EAP statusline companion — invokes the Node statusline (levels + measured bytes).
# Use when the agent prefers a shell command over `node …eap-statusline.mjs` directly.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/eap-statusline.mjs"
