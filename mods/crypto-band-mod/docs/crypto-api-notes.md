# CoinGecko notes

crypto-band-mod prices everything off one endpoint:

```
GET https://api.coingecko.com/api/v3/coins/markets
    ?vs_currency=usd
    &ids=bitcoin,ethereum,solana,hyperliquid
    &price_change_percentage=1h,24h
```

No API key, no account (verified 2026-09-19: HTTP 200 with no auth header on
the public `api.coingecko.com` host). One request answers every configured
coin at once - `coins/markets` has no per-request id cap the way Yahoo's
spark endpoint caps a request at 20 symbols, so `hooks/register.tsx` never
has to batch it.

## Why this one endpoint covers the whole table

The brief's five columns - 幣種, 美元價格, 1h%, 24h%, 24h成交量 - are all in
this single response, per row:

| column | field |
| --- | --- |
| 幣種 | `symbol` (already `btc`/`eth`/`sol`/`hype` for the four v1 coins - `.toUpperCase()` in `parseMarkets`) |
| 美元價格 | `current_price` |
| 1h 漲跌幅 | `price_change_percentage_1h_in_currency` (only present because `price_change_percentage=1h,24h` was passed) |
| 24h 漲跌幅 | `price_change_percentage_24h_in_currency`, falling back to the always-present `price_change_percentage_24h` |
| 24h 成交量 | `total_volume` |

tw-stock-mod's crypto market (this mod started as a copy of it) needed a
second source, CoinGecko's `circulating_supply`, layered under Pionex's
ticker prices to compute a market cap for its `marketcap` sort. crypto-band
does not sort by market cap at all (see BoardProps.sortKey in board.tsx) and
`coins/markets` already answers `market_cap` directly if a future version
wants it back - no second endpoint, no supply cache, no TTL bookkeeping.

## Rate limit and the 30s floor

CoinGecko's public API documents no fixed per-endpoint free-tier limit the
way Pionex publishes "10/s as a weight budget" (see tw-stock-mod's own notes
on that). `FEED_MS_MIN = 30_000` in `hooks/register.tsx` is the requirement
brief's own floor ("行情至少間隔 30 秒抓取一次"), not a measured CoinGecko
number - it also keeps this module comfortably inside whatever the public
tier's actual limit turns out to be, since it is one request per tick
regardless of how many coins are configured.

## Never a fabricated price

A failed request (network error, non-2xx, unparseable body, or an answer
with no usable rows) never touches `quotes` - see `feedOnce`/`backOff` in
`hooks/register.tsx`. The board keeps drawing the last successful snapshot
and flags it 資料延遲 (`BoardProps.stale`) until a request succeeds again.
Unlike tw-stock-mod, there is no demo-price sine-walk fallback anywhere in
this module: before the first successful fetch, the board draws nothing
(`crypto-band: 等待報價中…`) rather than a placeholder price.
