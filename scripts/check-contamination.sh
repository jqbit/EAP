#!/usr/bin/env bash
# Clean-room contamination guard for EAP-Runtime.
#
# EAP-Runtime is an independent clean-room reimplementation of the
# context-offload pattern; it must contain ZERO source code from the
# Elastic-Licensed upstream. This gate enforces that by scanning SOURCE CODE for
# upstream identifiers and by rejecting any vendored upstream bundle.
#
# Prose documentation (docs/**, *.md, NOTICE) is EXEMPT: naming the upstream for
# attribution and for the honesty rationale (why we do not reprint its numbers)
# is required, not contamination. The clean-room rule is "copy no code", not
# "never say the name".
set -euo pipefail
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/.."

fail=0
pattern='context-mode|mksglu|Koseoglu|Köseoğlu|Elastic-2\.0|Elastic License 2\.0|\bELv2\b'

# 1. Scan SOURCE CODE only (not docs/markdown) for upstream identifiers.
# Capture grep's real exit code: 0 = matches found (contamination -> FAIL),
# 1 = no matches (clean -> pass), >=2 = grep itself errored (bad pattern,
# unreadable tree) which we must treat as a HARD FAIL, not a silent pass.
# The old `|| true` masked >=2 into a clean pass (fail-open).
code_hits="$(grep -RInE "$pattern" . \
  --include='*.mjs' --include='*.cjs' --include='*.js' \
  --include='*.mts' --include='*.cts' --include='*.ts' \
  --include='*.jsx' --include='*.tsx' \
  --include='*.py' --include='*.json' \
  --exclude-dir=.git --exclude-dir=node_modules \
  2>/dev/null)" && rc=0 || rc=$?
if [ "$rc" -ge 2 ]; then
  echo "FAIL: contamination scan errored (grep exit $rc); refusing to pass." >&2
  fail=1
elif [ "$rc" -eq 0 ] && [ -n "$code_hits" ]; then
  echo "FAIL: ELv2 upstream identifier found in SOURCE CODE (clean-room breach):" >&2
  echo "$code_hits" >&2
  fail=1
fi

# 2. Vendored upstream bundles are never allowed, anywhere.
bundles="$(find . -name '*.bundle.mjs' -not -path './.git/*' 2>/dev/null || true)"
if [ -n "$bundles" ]; then
  echo "FAIL: vendored upstream bundle(s) present:" >&2
  echo "$bundles" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "Clean-room guard FAILED." >&2
  exit 1
fi
echo "OK: clean-room guard passed (no ELv2 source contamination)."
