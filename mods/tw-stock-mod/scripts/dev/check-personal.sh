#!/usr/bin/env bash
# Fails (exit 1) if any personal path or username leaked into the repo -
# your-venv (the old shioaji venv/env path), an absolute
# /Users/you path, or the bare username. Run before every release;
# session-recap and the v0.10.0 doc pass both use this.
set -euo pipefail

# Repo root from this script's own location, not a hardcoded reviewer path -
# mods/tw-stock-mod/scripts/dev/check-personal.sh is four levels under it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

# prototype/ is NOT excluded: it is real repo content and has carried a
# leaked personal path before (render-styles.py's hardcoded jobs-tmp file).
if rg -n 'Darrell/investment|/Users/darrellwang|darrellwang' \
  "$REPO_ROOT" \
  --glob '!node_modules' \
  --glob '!.git' \
  --glob '!**/check-personal.sh' \
  --glob '!**/scripts/dev/README.md'; then
  echo "check-personal: found personal paths above" >&2
  exit 1
fi

echo "check-personal: clean"
