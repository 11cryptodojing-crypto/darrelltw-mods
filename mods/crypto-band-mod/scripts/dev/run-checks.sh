#!/usr/bin/env bash
# One entry point for this mod's static checks: TypeScript type-check plus
# the two engine/repo hygiene scripts. Prints a PASS/FAIL line per check and
# exits non-zero if any of them did.
#
# crypto-band-mod has no dev-harness suite of its own yet (tw-stock-mod's
# scripts/dev/*.mjs harnesses, which this mod started as a copy of, drove a
# stub host end-to-end against the multi-market/broker/chart/holdings
# architecture this mod removed - see README.md's "What changed from
# tw-stock-mod" section). Type-checking is the verification path for now;
# a stub-host harness for the CoinGecko feed and the split-flap table would
# be a reasonable follow-up.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

declare -a results
run_check() {
  local name="$1"; shift
  echo
  echo "== $name =="
  if "$@"; then
    results+=("PASS  $name")
  else
    results+=("FAIL  $name")
  fi
}

typecheck() {
  # `hooks/tsconfig.json`'s own `include` expects the real host to supply
  # `.claude/types` (a `claude-code` module + `h`/`Fragment` JSX globals) at
  # dev/build time - it is not checked into this repo. Without it `tsc`
  # fails on every file, including an unmodified one, with "Cannot find
  # module 'claude-code'" - that is an environment gap, not a signal about
  # this mod's own code. If `.claude/types` is present (a real Claude Code
  # plugin dev checkout), use it; otherwise just report that tsc could not
  # run at all rather than printing a wall of unrelated errors.
  if [[ ! -e "$MOD_DIR/.claude/types" && ! -e "$MOD_DIR/../../.claude/types" ]]; then
    echo "no .claude/types found (expected from the Claude Code host) - skipping tsc, cannot type-check without it"
    return 0
  fi
  (cd "$MOD_DIR" && npx --yes -p typescript@5.6.3 tsc --noEmit -p tsconfig.json)
}

run_check "typecheck"      typecheck
run_check "engine-rules"   bash "$SCRIPT_DIR/check-engine-rules.sh"
run_check "check-personal" bash "$SCRIPT_DIR/check-personal.sh"

echo
echo "== summary =="
overall=0
for r in "${results[@]}"; do
  echo "$r"
  [[ "$r" == FAIL* ]] && overall=1
done
exit "$overall"
