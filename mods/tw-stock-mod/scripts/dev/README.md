# dev harnesses

Run the real `hooks/register.tsx` and `hooks/board.tsx` against a stub host and
the real endpoints, outside Claude Code. Every bug fixed on 2026-09-16 was
found with these rather than by reading the diff — the band draws into a
terminal surface that a screenshot only samples once, so "it looks wrong" is
never enough to act on.

## Build first

```sh
OUT=/tmp/tw-stock-mod-dev
bunx esbuild hooks/register.tsx --bundle --format=esm --jsx-factory=h \
  --jsx-fragment=Fragment --external:claude-code --outfile=$OUT/register.js
bunx esbuild hooks/board.tsx --bundle --format=esm --jsx-factory=h \
  --jsx-fragment=Fragment --external:claude-code --outfile=$OUT/board.js
```

`<proj>` below is a directory holding `.claude/stock-band.json` (and optionally
`.claude/stock-quotes.json`) — the real project works, and so does a throwaway
one with just a config in it.

## What each one answers

| script | question | usage |
| --- | --- | --- |
| `harness.mjs` | what props does the feed actually build? prices, indices, source tag, K bars | `node harness.mjs $OUT/register.js <config.json> [ticks]` |
| `board-harness.mjs` | what do the nine rows look like, as text | `node board-harness.mjs $OUT/board.js $OUT/register.js <proj>` |
| `frames.mjs` | does the animation play, and what does each frame look like | `node frames.mjs $OUT/board.js $OUT/register.js <proj> <seconds>` |
| `remount.mjs` | does a remounted board install its own frame clock | `node remount.mjs $OUT/board.js <props.json>` |
| `snooze.mjs` | does 收起 30分 then 展開 leave the band without a frame clock | `node snooze.mjs $OUT/board.js $OUT/register.js <proj>` |
| `switch.mjs` | does pressing `m` fetch the market it lands on | `node switch.mjs $OUT/register.js <config.json>` |

## Two things the stubs get wrong on purpose

- `$.clock.every` callbacks are fire-and-forget in the host too, so a test that
  calls one has to `await` a real timeout afterwards or it reads the state from
  before the fetch landed.
- `frames.mjs` redraws on its own 50 ms loop rather than waiting for the board's
  `setState`, so it shows every frame the board *could* draw. That is what makes
  it the right tool for "is the animation correct" and the wrong one for "does
  the host paint it" — `remount.mjs` and `snooze.mjs` cover the second.
