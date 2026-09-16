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
| `page-reset.mjs` | does pressing 翻頁 push the auto-page deadline out | `node page-reset.mjs $OUT/register.js <proj> <press-at-ms>` |
| `chart-nav.mjs` | do 上一檔／下一檔／回清單 move the focus and wrap | `node chart-nav.mjs $OUT/register.js <proj>` |
| `click-to-chart.mjs` | does clicking a table row open that symbol's chart | `node click-to-chart.mjs $OUT/board.js $OUT/register.js <proj> [columns]` |
| `real-click.py` | does a REAL click in a REAL Claude Code open the chart | `python3 real-click.py <proj> [x] [row] [--plugin-dir <path>]` |
| `feed-idle.mjs` | does a closed market stop being polled, and does its snapshot still hold | `node feed-idle.mjs $OUT/register.js <proj>` |
| `feed-open-snooze.mjs` | does an open market still get polled, and does 收起 stop it | `node feed-open-snooze.mjs $OUT/register.js <proj>` |

## The clock is yours to drive

`feed-idle.mjs` and `feed-open-snooze.mjs` replace `$.clock.now` with a variable
they push forward by whole minutes and call every registered `$.clock.every`
callback by hand. That is the only way to ask "what happens two hours after the
close" or "what happens at 10:30 on a trading Wednesday" without waiting for it,
and it is how the market-hours behaviour was measured rather than argued about.
`feed-open-snooze.mjs` hard-codes 2026-09-16T10:30+08:00 — move that date to a
weekday inside Taiwan hours if you re-run it much later.

Both count `$.http.fetch` calls, so the number they print is requests actually
made against the real endpoint, not an estimate.

## Two things the stubs get wrong on purpose

- `$.clock.every` callbacks are fire-and-forget in the host too, so a test that
  calls one has to `await` a real timeout afterwards or it reads the state from
  before the fetch landed.
- `frames.mjs` redraws on its own 50 ms loop rather than waiting for the board's
  `setState`, so it shows every frame the board *could* draw. That is what makes
  it the right tool for "is the animation correct" and the wrong one for "does
  the host paint it" — `remount.mjs` and `snooze.mjs` cover the second.

## The stub host cannot answer everything

`real-click.py` opens a real Claude Code in a pty, waits for the band, sends a
real SGR mouse click and reads the screen back with `pyte` (`pip install --user
pyte`). It exists because on 2026-09-16 every stub-host harness passed while the
feature did nothing in the real app: the `ui.message` event reports `e.module` as
`hooks/board.tsx`, and the hook was comparing it against the `./board.tsx`
literal the `Client` prop carries. The stub host never had an opinion about that
string, so it could not catch it.

Rule of thumb: the `.mjs` harnesses prove the module's own logic; this one proves
the engine and the module agree on what they hand each other.
