---
name: stock-quote-sources
description: Use when the user wants to change, choose, or wire where tw-stock-mod's stock prices come from — switching the feed, connecting a broker or vendor API, or asking why a price looks stale. Trigger words include 換報價來源, 接證交所, 接永豐, 接 API, 即時報價, 股價來源, 換成 Yahoo, quote source, switch feed, wire shioaji, real-time quotes.
---

# Wiring tw-stock-mod's quote sources

Full detail, exact JSON, exact commands, and what each route does and does
not carry: [`../../references/quote-sources.md`](../../references/quote-sources.md).
Read it before editing config — this file only routes you to the right
section.

## Decision table

| What the user wants | Route |
| --- | --- |
| Just works, no setup | Yahoo — already the default for both markets |
| Real intraday Taiwan prices, no key | 證交所 MIS — one config line |
| Prices from their own broker or a paid vendor | The quotes-file override, fed by a script |
| Specifically 永豐/Sinopac | Shioaji — a ready-made script for the override |
| Specifically 富果/Fugle | Not built in — write a small fetcher into the override (§5 of the reference) |
| Something else entirely (custom data, a simulator) | Write a fetcher into the override ("Write your own fetcher" in the reference) |

## Steps per route

**Yahoo (default).** Nothing to do. To be explicit, set
`"twSource": "yahoo"` in `<project>/.claude/stock-band.json`. Footer tag:
`Yahoo 即時` (US) / `Yahoo 延遲` (Taiwan, ~20 min behind).

**證交所 MIS (opt-in, real-time Taiwan).** In
`<project>/.claude/stock-band.json`, set `"twSource": "mis"`. If the
watchlist has 上櫃 symbols, each one needs `"ex": "otc"` or it returns
nothing. Footer tag: `證交所 即時`.

**永豐 Shioaji.** Get a 永豐金 account with the API enabled and 簽署中心
passed, put `SINOBON_API_KEY`/`SINOBON_SECRET_KEY` in an env file outside the
repo, then run:

```sh
~/.venvs/shioaji/bin/python3 \
  mods/tw-stock-mod/scripts/fetch-quotes-shioaji.py \
  --env ~/.sinobon.env --project . --interval 10
```

Leave it running — it holds a login session and writes
`<project>/.claude/stock-quotes.json` on a loop. Footer tag: `永豐 即時`.

**富果 Fugle, or any other vendor.** Not wired into the module. Write a small
script that calls the vendor's API and writes
`<project>/.claude/stock-quotes.json` in the shape of
[`../../stock-quotes.example.json`](../../stock-quotes.example.json) — see
"Write your own fetcher" in the reference for the file contract, the failure
rule (a failed fetch leaves the file alone), and the rate-limit traps that hit
the built-in feed (missing `User-Agent`, cached URLs, budget vs. interval).

## Checking it took

The band's footer names its source: `Yahoo 即時` / `Yahoo 延遲` / `證交所
即時` / a fetcher's own `source` string, falling back to `報價檔` / `示範資料
（未接 API）` when nothing is fresh. If the footer still says 示範資料 after
wiring a route, the feed or the override file is not landing — check the file
is younger than 120 seconds and re-read the matching section of
`../../references/quote-sources.md`.
