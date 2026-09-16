# Quote sources

This page answers one question: where do the band's prices come from, and how
do you point it at a different source. The measurement log behind every claim
here — exact requests, exact bytes back, exact failures — lives in
[`docs/stock-api-notes.md`](../../../docs/stock-api-notes.md). Read this page
to choose a source; read that one to see the evidence.

Every route below writes into the same two places the band already reads:
`hooks/register.tsx`'s built-in feed (Yahoo, MIS) or the
`<project>/.claude/stock-quotes.json` override file (everything else). Nothing
you configure changes `hooks/board.tsx` — the band does not know or care which
route filled in a number.

## Compare the routes

| Route | Key / account | Process to keep running | Freshness | Intraday series (`spark` column) | K bars | 昨收 (previous close) | 上市/上櫃 resolution | Footer tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Yahoo** (default) | none | none | US: real-time. Taiwan: ~20 min behind | Yes, native | Yes, native | Yes | Config's own `"ex": "otc"` | `Yahoo 即時` (US) / `Yahoo 延遲` (Taiwan) |
| **證交所 MIS** | none | none | Real intraday (~5 s snapshot) | No — borrows one Yahoo call for this column only | No — same borrow, per-symbol | Yes (`y` field) | Config's own `"ex": "otc"`, on the `otc_` channel | `證交所 即時` |
| **Quotes-file override** | depends on what writes it | depends on what writes it | Whatever the writer promises | Only if the writer fills `series` | Only if the writer fills `bars` | Only if the writer fills `prevClose` | Handled by the writer, before the file is written | `source` string in the file, or `報價檔` if it leaves that blank |
| **永豐 Shioaji** | 永豐金 brokerage account + API access | Yes — a long-lived login | Real intraday tick | No — the script does not fill it (unverified whether Shioaji itself carries one) | No — same | Yes (`contract.reference`) | Automatic — the SDK resolves it | `永豐 即時` |
| **Fugle 富果** (not wired) | Free Fugle membership | Whatever you write | Real intraday | Not from the one REST endpoint checked | Not from the one REST endpoint checked | Yes (`previousClose`) | Automatic — the symbol alone is enough | Whatever `source` your fetcher writes |

## 1. Yahoo (default)

No key, no account, nothing to run. This is what the band uses out of the box
for both markets.

**What it does and does not carry.** One `spark` request answers the whole
watchlist plus the market's indices — current price, previous close, the
day's 5-minute closes (`indicators.quote[0].close[]`, what feeds the `spark`
trend column), and `regularMarketTime` (the exchange's own clock, printed as
更新). A separate `chart` request per symbol answers OHLC bars for the `kbar`
column and the trend view.

**Freshness.** US quotes are real-time. Taiwan quotes through Yahoo run about
20 minutes behind — measured 2026-09-16: Yahoo said 10:29:05 for 2330 while
證交所 MIS said 10:48:36 for the same symbol at the same moment. That gap is
why Taiwan also has an opt-in real-time route (§2).

**Turn it on.** Nothing to do — it is the default for both markets. To be
explicit about it in `<project>/.claude/stock-band.json`:

```jsonc
{ "twSource": "yahoo" }
```

**How to tell it took.** The footer reads `Yahoo 即時` on the US board and
`Yahoo 延遲` on the Taiwan board — the label itself says which market and
whether the number is live or 20 minutes old.

**Limits worth knowing before you touch `feedMs`.** A `spark` request caps at
20 symbols — a 21st gets `Number of symbols needs to be less than or equal to
20` back, so a full watchlist plus indices costs two requests, not one. No
official rate limit is published; the community number is roughly 360
requests/hour, and the band's own budget of 300/hour (see §6) sits under it on
purpose.

## 2. 證交所 MIS (opt-in, `"twSource": "mis"`)

No key, no account, nothing to run — same shape as Yahoo, but Taiwan-only and
truly real-time.

**How to turn it on.** One line in `<project>/.claude/stock-band.json`:

```jsonc
{ "twSource": "mis" }
```

**What it does and does not carry.** One request answers the whole Taiwan
watchlist plus 加權指數 and 櫃買指數 together — current price, previous close
(`y`), open/high/low, volume, and the trade timestamp. It carries **no
intraday series and no bars** — MIS is a snapshot, not a history. The `spark`
trend column still needs a series, so turning it on with `twSource: "mis"`
makes the feed pay for one extra Yahoo call just for that column; the `kbar`
column and the trend view already go to Yahoo per-symbol on both routes.

**上市/上櫃.** MIS reads a symbol's exchange off the config, not off the
symbol itself: a 上櫃 stock needs `"ex": "otc"` in its watchlist entry, and it
answers on the `otc_` channel (`otc_6488.tw`) instead of `tse_`
(`tse_2330.tw`). Get this wrong and the symbol comes back with nothing.

**The `z`-field trap.** MIS's `z` field — the last trade — reads `-` between
trades, not the last price and not zero. The actual last deal is in
`trade.z`; a symbol that has not traded yet today falls further back to `o`
(open) and finally `y` (previous close). Reading `z` alone leaves the row
blank whenever the market pauses between prints.

**How to tell it took.** The footer reads `證交所 即時`.

**Rate limits.** No published limit, and the response carries no rate-limit
headers — this is an internal endpoint the exchange's own market-data page
calls, not a documented public API. Measured: 1-second intervals, 8 requests
in a row, all `200` with `rtcode 0000`. The band's default (30 s, one batched
request for the whole watchlist) sits far under anything tested.

## 3. The quotes-file override

Write `<project>/.claude/stock-quotes.json` in the shape of
[`stock-quotes.example.json`](../stock-quotes.example.json), and the band
uses it instead of Yahoo or MIS — **this is the seam for any source the
module does not speak natively**, including Shioaji (§4) and Fugle (§5).

**The contract.** A file with these keys:

```jsonc
{
  "asOf": 1757900000000,        // when this file was written, ms epoch
  "dataAt": 1757900000000,      // when the prices traded — printed as 更新
  "market": "tw",               // informational; the band still picks the market off the clock
  "source": "永豐 即時",         // names itself in the footer instead of 報價檔
  "barLabel": "5 分 K",
  "quotes": {
    "2330": {
      "price": 1188.0,
      "prevClose": 1165.0,
      "name": "台積電",
      "series": [1166.0, 1170.5, /* … */ 1188.0],   // recent closes, oldest first — feeds `spark`
      "bars": [[1165.0, 1172.0, 1164.0, 1170.5], /* … */]  // [open, high, low, close], oldest first
    }
  },
  "index": { "value": 24340.24, "change": 288.54, "pct": 1.2 },
  "indices": [{ "name": "TAIEX", "value": 24340.24, "change": 288.54, "pct": 1.2 }]
}
```

Only `code` → `price` is required per quote; everything else is optional and
each field is independent — you can hand over prices with no series and no
bars, and the band just draws a plainer row. `indices` (plural) is what the
footer's split-flap index board flips through; `index` (singular) is the
older single-index shape and still works.

**Freshness rule.** Older than 120 seconds, malformed, or missing, and the
band ignores the file and falls back to whatever the built-in feed has (or to
demo prices if neither is fresh). There is no partial trust — a stale file is
treated exactly like no file.

**How to tell it took.** The footer shows whatever string you put in
`source`; leave it out and it falls back to `報價檔`.

## 4. 永豐 Shioaji, through `scripts/fetch-quotes-shioaji.py`

**What you need:**

- A 永豐金 brokerage account with the API enabled and 簽署中心 passed.
- `SINOBON_API_KEY` / `SINOBON_SECRET_KEY` in an env file outside the repo.
- A Python 3.12 environment with `shioaji` installed (the SDK caps at Python
  3.13; the working environment on this machine is
  `~/.venvs/shioaji`, Python 3.12.6, shioaji 1.7.2).
- **A long-lived process.** `api.login()` takes seconds and holds a session —
  measured: `api.usage()` after login reports `connections=1,
  limit_bytes=524288000`. Calling it every 30 seconds the way the built-in
  feed calls Yahoo or MIS means logging in and out every 30 seconds, which is
  not what a broker session is for.

**Why this cannot live inside the hooks module.** MIS and Yahoo are both one
HTTP GET — `$.http.fetch` calls them directly. Shioaji is a Python SDK; the
hooks module runs in a JS sandbox and can only reach it through `$.process`.
And there is no 永豐 CLI to spawn per-tick anyway: `pip install shioaji`
installs a `shioaji` command, but running it only prints `Hello from
shioaji!` — it is a placeholder entry point (`shioaji/__init__.py:18`), not an
interface. The SDK's Python API is the whole interface, so a script that logs
in once and stays running is the shape that fits, writing the override file
from §3 on a loop.

**Turn it on:**

```sh
~/.venvs/shioaji/bin/python3 \
  mods/tw-stock-mod/scripts/fetch-quotes-shioaji.py \
  --env ~/.sinobon.env --project . --interval 10
```

It reads the same `tw` watchlist out of `<project>/.claude/stock-band.json`,
so there is nothing else to configure. Stop it with Ctrl-C; the band falls
back to its own feed 120 seconds after the file goes stale.

**What it carries.** `api.snapshots()` gives current price, and
`contract.reference` gives 昨收 in the broker's own terms — this stays correct
through an ex-dividend date, unlike a plain "yesterday's close".
`snapshot.close` is always the last trade; unlike MIS's `z` it never reads
`-`, so there is no between-trades gap to patch. 上市/上櫃 resolves itself —
the script does not need an `"ex": "otc"` hint the way MIS does.

**The timestamp trap.** `snapshot.ts` is nanoseconds, but Shioaji stamps it
with **Taipei wall-clock time counted as if it were UTC** — a snapshot taken
at 10:55 comes back reading 18:55, exactly 8 hours ahead. The script
subtracts a constant 8-hour offset before writing `dataAt`; anything else
reading `snapshot.ts` directly has to do the same subtraction, or the band
prints `更新 18:55` for a 10:55 snapshot.

**How to tell it took.** The footer reads `永豐 即時` (the script sets
`"source": "永豐 即時"` in the file it writes).

## 5. Fugle 富果 and other keyed vendors (not wired)

Fugle is not built into the module. Route 3 (the quotes-file override) is how
it — or any other vendor with a key — reaches the band; nobody has written
that fetcher yet. What it has to do:

- **Get its own API key.** Fugle's free tier needs only a Fugle membership,
  not a brokerage account — that requirement is for the *trading* API, not
  the market-data one.
- **Call Fugle's intraday quote endpoint per symbol.** The free REST tier has
  no batch/snapshot endpoint, so a 20-symbol watchlist costs 20 requests per
  refresh, and the endpoint caps at 60 requests/minute. A full watchlist
  refresh under that cap lands far slower than MIS's one request for the same
  20 symbols — do not expect sub-minute updates from this route without a
  paid tier.
- **Map Fugle's fields onto the quotes-file contract from §3**: its quote
  response's last price, previous close and quote timestamp become that
  symbol's `price`, `prevClose` and the file's `dataAt`.
- **Respect Fugle's terms**, which matter more here than for Yahoo or MIS
  because Fugle actually publishes them: no forwarding market data to a third
  party, and one Fugle account per user — a plugin cannot embed a shared key
  and proxy requests for everyone who installs it. Each user who wants this
  route has to get their own key and run their own fetcher.
- Set `"source"` to something that says so, e.g. `"富果 即時"`, so the footer
  does not claim `報價檔` with no indication of where the numbers came from.

Fugle resolves 上市/上櫃 by symbol alone — its data source already spans both
the exchange and 櫃買中心, so a fetcher does not need an `"ex"` hint the way
MIS does.

## Write your own fetcher

Any source not listed above — another vendor, a spreadsheet, a paper-trading
simulator — reaches the band the same way Shioaji does: write
`<project>/.claude/stock-quotes.json` in the §3 shape, on whatever schedule
your source supports.

**The file contract**, restated: `asOf` and `dataAt` in epoch milliseconds,
`quotes` keyed by the same codes as the watchlist, `price` required and
everything else optional, `source` to name yourself in the footer.

**The failure rule.** A failed fetch must leave the file alone rather than
write a stale price back into it. The band already treats a file older than
120 seconds as gone and falls back to a live feed or demo prices — writing a
fresh `asOf` with old numbers defeats that safety net and makes a stale price
look live.

**Rate-limit facts that bit the built-in feed, and will bite a custom one the
same way:**

- **A request with no browser `User-Agent` gets `429`** on the very first
  try against Yahoo, and the ban lasts on the order of minutes once it hits.
  Send a real browser UA string on every request.
- **A repeated URL comes back cached, byte-identical, with a frozen price** —
  measured six ticks over 80 seconds returning the same body. Carry a
  `_=<timestamp>` query parameter and `Cache-Control: no-cache` /
  `Pragma: no-cache` headers on every request so each one is a distinct URL.
- **The feed enforces a 300 requests/hour budget, not just an interval.**
  `feedMs` alone cannot bound the request rate once one tick costs more than
  one request (a wide watchlist split across two `spark` calls, or the K-bar
  column adding a per-symbol request) — a fetcher polling on a fixed interval
  has to account for its own per-tick request count against whatever budget
  its source actually allows, the same way the built-in feed works out its
  interval from `REQUESTS_PER_HOUR` rather than trusting `feedMs` alone.
