# crypto-band-mod

A crypto watchlist band above the Claude Code prompt, in the style of a
broker's watchlist table: 標記(固定/熱門) / 幣種 / 價格 / 1h% / 24h% / 24h量,
green up / red down. Crypto trades 24/7, so unlike a stock band there is no
session state, no open/closed hours, and no timezone note - one table, one
market, always on.

Tracks BTC/ETH/SOL/HYPE as fixed coins out of the box (configurable to any
coin CoinGecko lists - see [Configuration](#configuration)), plus whatever
CoinGecko currently reports as trending, refreshed every 10 minutes. Each
row is tagged 固定 or 熱門 so it is always clear why a coin is on the board.
A watchlist over five coins auto-pages instead of scrolling or squeezing two
coins onto one row - see [The trending list](#the-trending-list).

**Prices come from CoinGecko's public `coins/markets` endpoint** - no key,
no account, polled at least every 30 seconds. One request answers price,
1h%, 24h% and 24h volume for every fixed and trending coin at once - fixed
and trending coin ids are merged into a single `ids` list, never fetched
one at a time. **A failed request never invents a price**: the last
successful snapshot stays on screen, the footer says 資料延遲, until a
request succeeds again - there is no demo-price fallback anywhere in this
module. See [docs/crypto-api-notes.md](docs/crypto-api-notes.md) for the
endpoint and field-mapping decisions, and [The live feed](#the-live-feed)
below for the failure/backoff behavior.

This mod started as a copy of [tw-stock-mod](../tw-stock-mod) - see
[What changed from tw-stock-mod](#what-changed-from-tw-stock-mod) for what
carried over (the table/two-column/paging/sort/button framework and the
split-flap color scheme) and what did not (TW/US markets, broker fetchers,
the chart view, the 損益 holdings view).

## Requirements

- Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set in
  `~/.claude/settings.json`:

  ```json
  { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
  ```

  (Merge the `env` key if the file already has one.)
- An interactive terminal. The band is `AbovePrompt`, so nothing draws in
  `claude -p`, the desktop app, or mobile.

## Install

Install from inside the project you want the band in. `--scope local` keeps
the mod in that one project:

```sh
claude plugin marketplace add darrell-tw/darrelltw-mods
cd /path/to/your/project
claude plugin install crypto-band-mod@darrelltw-mods --scope local
```

Restart Claude Code in that project and the band appears above the prompt.
Drop `--scope local` to get the band in every project on the machine.

Or try it for one session without installing:

```sh
git clone https://github.com/darrell-tw/darrelltw-mods.git
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir darrelltw-mods/mods/crypto-band-mod
```

To remove it:

```sh
claude plugin uninstall crypto-band-mod@darrelltw-mods --scope local
claude plugin marketplace remove darrelltw-mods
```

## Configuration

Optional: copy [`crypto-band.example.json`](crypto-band.example.json) to
`<project>/.claude/crypto-band.json`. Every key has a default, so a partial
file is fine; `/crypto-band-setup` walks through picking and verifying coin
ids interactively.

```json
{
  "fixedCoins": [
    { "id": "bitcoin" },
    { "id": "ethereum" },
    { "id": "solana" },
    { "id": "hyperliquid" }
  ]
}
```

`fixedCoins` entries are **CoinGecko coin ids**, not exchange tickers -
`bitcoin`, not `BTC` (see CoinGecko's `/api/v3/coins/list` for the full id
list). The table shows CoinGecko's own `symbol` for each id (already
`BTC`/`ETH`/`SOL`/`HYPE` for the four defaults); set `"symbol"` on an entry
to override what the table displays. Up to 30 coins.

Other keys, all optional: `trendingEnabled` (`true` default; see
[The trending list](#the-trending-list)), `trendingLimit` (`10` default,
clamped 1-15), `trendingRefreshMs` (`600000` default, clamped to 60000
minimum), `excludedCoins` (tickers that never count as trending; defaults to
a stablecoin list - see below), `sort` (`change24h` default, `change1h`,
`volume`, or `list`; the 排序 button cycles through all four at runtime),
`feedMs` (CoinGecko poll interval, clamped to 30000 minimum), `pageMs` (how
long a page holds before 翻頁 auto-advances, `0` for manual-only),
`highlight`, `animation` (`full`/`off`), `countdown`, `refreshMs` (how often
this module re-reads the config file - unrelated to how often CoinGecko is
polled). See the comments in `crypto-band.example.json` for what each one
does.

Changing `refreshMs`/`feedMs`/`trendingRefreshMs` needs `/reload-plugins` to
take effect - all three are fixed for the session at `session.start`.

## The trending list

On top of `fixedCoins`, this mod polls CoinGecko's public `search/trending`
endpoint - also no key, no account - on its own clock (`trendingRefreshMs`,
default 10 minutes, independent of the price feed and of how often the band
redraws). It takes the top `trendingLimit` (default 10) coins out of the
up-to-15 CoinGecko answers, skipping anything already in `fixedCoins` and
anything whose ticker is in `excludedCoins` (stablecoins - `USDT`, `USDC`,
`DAI`, `FDUSD`, `USDe`, `USDS` - by default, since their price barely
moves). The fixed and trending coin ids are merged into one `ids` list for
the same `coins/markets` request the price feed already makes - trending
coins never get their own request.

A failed trending request keeps the last successful trending list on
screen (never clears it, never invents one); on the very first launch, if
that first trending fetch fails, the board just shows the four fixed coins
until a trending request succeeds. Set `"trendingEnabled": false` to turn
trending off entirely and show only `fixedCoins`.

Each row's 幣種 cell is followed by a 固定 or 熱門 tag saying which kind of
coin it is.

## The live feed

`hooks/register.tsx` polls CoinGecko's `coins/markets` endpoint on its own
clock (`feedMs`, minimum 30s) - see `docs/crypto-api-notes.md` for exactly
what it asks for and why one request covers the whole table. On success the
board's live dot steps and the footer clock updates to when the snapshot was
taken. On failure (network error, non-2xx, or an unparseable/empty answer)
the module backs off exponentially (capped at 5 minutes) and the footer
switches to 資料延遲 · 更新 HH:MM:SS - the last good prices stay on screen
throughout. Before the very first successful fetch, the board draws nothing
(`crypto-band: 等待報價中…`) rather than a placeholder price.

## Buttons

- **排序** cycles the sort key (24h% → 1h% → 成交量 → 預設 → …); the active
  key's header cell gets a `↓` arrow.
- **翻頁** (only shown once the watchlist needs more than one page) turns
  the table by hand; `pageMs` also turns it automatically.
- **收起 30分** collapses the band for 30 minutes, leaving one row behind
  with a button to bring it back early.

## What changed from tw-stock-mod

crypto-band-mod is not a from-scratch rewrite - it started as a copy of
tw-stock-mod's `hooks/` and was cut down to what the crypto-band brief asked
for. Kept: the table, paging, sort, buttons, and the split-flap row-turn
animation and color scheme (green up / red down is already tw-stock-mod's
US-market convention). Removed entirely, since crypto is a single 24/7
market: TW/US market switching and the market-select control, market
open/closed phase and the Taipei-time restatement, the K-bar chart view,
the 損益 holdings view, the broker fetchers (永豐 Shioaji / 群益 Capital) and
the Yahoo/證交所 MIS feeds, the quotes/holdings override files, and the
demo-price sine-walk fallback (see [The live feed](#the-live-feed) - a
failed fetch shows 資料延遲 over the last real snapshot instead). tw-stock-mod's
two-coins-a-row layout for a >5-coin watchlist was also dropped once every
row needed a 固定/熱門 tag on top of 幣種/價格/1h%/24h%/24h量 - see
[The trending list](#the-trending-list) - there is no room for that in two
columns, so the board is single-column with pagination now.

## License

MIT - see [LICENSE](LICENSE).
