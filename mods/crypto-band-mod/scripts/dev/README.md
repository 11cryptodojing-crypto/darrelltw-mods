# dev checks

`run-checks.sh` is the one entry point:

```sh
bash scripts/dev/run-checks.sh
```

It runs, in order:

1. **typecheck** - `tsc --noEmit` against `hooks/`, using the `claude-code`
   module types the real Claude Code host provides at `.claude/types`. That
   directory is not checked into this repo (it is supplied by the host at
   dev/build time), so this step reports "skipping" rather than a wall of
   `Cannot find module 'claude-code'` errors when it is absent - see the
   comment in `run-checks.sh` itself.
2. **check-engine-rules.sh** - a static grep for the two module rules the
   real host enforces at load time but `tsc`/bundlers do not: nothing may
   shadow `next` (the hook continuation), and a `$` noun is always called,
   never read with `?.`. Keep this whenever adding a new top-level `const`/
   `function` to `hooks/register.tsx`.
3. **check-personal.sh** - fails if a personal path or username leaked into
   the repo. Run before every release.

## Why there is no stub-host harness suite here

tw-stock-mod (which this mod started as a copy of) has an extensive
`scripts/dev/*.mjs` harness suite that runs the real hooks module against a
stub host - see that mod's own `scripts/dev/README.md`. Those harnesses are
built around the architecture crypto-band-mod removed: TW/US market
switching, the quotes/holdings override files, the K-bar chart view, the 損益
holdings view, and the broker fetchers. None of it carried over cleanly, so
it was deleted rather than left in a state that silently tested nothing.

A stub-host harness for what crypto-band-mod actually does - does
`parseMarkets` read a `coins/markets` response correctly, does a failed
fetch keep the last quotes and flag `stale`, does the split-flap table turn
on a page/sort change - would be a reasonable follow-up. `docs/crypto-api-
notes.md` has the field mapping a new harness would need to fake a CoinGecko
response against.
