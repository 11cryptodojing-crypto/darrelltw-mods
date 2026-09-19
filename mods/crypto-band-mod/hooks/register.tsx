/* @jsx h */
import type { Register } from 'claude-code'

// crypto-band-mod: a crypto watchlist band above the Claude Code prompt.
// Crypto trades 24/7, so unlike tw-stock-mod (which this module started
// life as a copy of) there is no market session, no open/closed phase, no
// timezone note, and no per-market switching - one table, one data source,
// always on.
//
// Prices come from CoinGecko's public `coins/markets` endpoint - no API
// key, no account (see COINGECKO_MARKETS_URL below). One request a tick
// answers price, 1h%, 24h% and 24h volume for every configured coin at
// once, fixed coins and trending coins combined into a single `ids` list -
// see `activeCoins`. A failed request NEVER produces a made-up price: the
// board keeps the last successful snapshot on screen and flags it 資料延遲
// (see `feedHealthy` and BoardProps.stale in board.tsx) until a request
// succeeds again. There is no demo-price fallback anywhere in this module.
//
// On top of the fixed watchlist, this module also polls CoinGecko's public
// `search/trending` endpoint on its own, much slower clock (`trendingRefreshMs`,
// default 10 minutes) to fill the rest of the table with whatever is
// currently trending - see `trendingFeedOnce`/`activeCoins`. A failed
// trending request keeps the last successful trending list (never clears
// it, never invents one); before the first successful trending fetch the
// table shows only the fixed coins.
//
// This module never calls $.model.* and never touches the prompt: it polls
// CoinGecko on its own clock, builds a quote snapshot, and draws a Client
// board (hooks/board.tsx).
//
// Never name a local variable `h`: every JSX tag in this file compiles to h(...).
// Never name a local variable or parameter `next`: it shadows the hook
// continuation every hook receives, and the engine refuses to load a module
// that shadows it.

const CONFIG_PATH = '.claude/crypto-band.json'

const DEFAULT_REFRESH_MS = 3000 // how often this module re-reads the config file and re-renders; NOT the feed interval
const FEED_MS_DEFAULT = 30_000
// "行情至少間隔 30 秒抓取一次" - a hard floor, so a config typo cannot spam
// CoinGecko's public endpoint faster than once every 30s.
const FEED_MS_MIN = 30_000
const FEED_BACKOFF_MAX_MS = 300_000
const SNOOZE_MS = 30 * 60 * 1000
const PAGE_SIZE = 5
const PAGE_MS_DEFAULT = 10_000
const PAGE_MS_MIN = 4000
const PAGE_TURN_WINDOW_MS = 2500 // how long after a page/sort turn the outgoing rows are still worth turning from
const TABLE_BOARD_ROWS = 8
const MAX_FIXED_COINS = 30
const DIM = '#6e7681'

// CoinGecko's free `coins/markets` endpoint - no API key needed (verified
// 2026-09-19, HTTP 200 with no auth header). `price_change_percentage=1h,24h`
// is what adds the `_in_currency` 1h/24h fields on top of the default
// 24h-only one; `total_volume` and `current_price` are already in the base
// response. One request covers every configured coin - CoinGecko does not
// impose the "20 symbols per request" cap Yahoo's spark endpoint does, so
// there is no batching to do here.
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets'

// CoinGecko's free `search/trending` endpoint - also no API key. Answers
// (at the time of writing) the current top-15 trending coins, ranked, under
// `coins[].item.{id,symbol,...}`. This module never trusts it for price -
// only for which coin ids are "trending" right now; the price still comes
// from the one coins/markets request above.
const COINGECKO_TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending'

const TRENDING_MS_DEFAULT = 600_000 // 10 minutes - "熱門名單每 10 分鐘更新一次"
// A config typo should not turn this into a second tight polling loop next
// to the price feed; trending data does not need to be fresher than this.
const TRENDING_MS_MIN = 60_000
const TRENDING_LIMIT_DEFAULT = 10
const TRENDING_LIMIT_MAX = 15 // CoinGecko's trending endpoint answers at most 15
// Stablecoins are never "trending" in the sense this table cares about -
// their price barely moves, so they would just sit on the board doing
// nothing while crowding out an actual mover. Matched against the
// uppercased ticker CoinGecko reports for a trending item, not the coin id.
const DEFAULT_EXCLUDED_COINS = ['USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'USDS']

type SortKey = 'change24h' | 'change1h' | 'volume' | 'list'
type CoinOrigin = 'fixed' | 'trending'

/** a config entry: a CoinGecko coin id, plus an optional display override for its ticker */
type CoinConfig = { id: string; symbol?: string }

/** one coin currently on the watchlist, fixed or trending, after fixedCoins/trending have been merged and deduped */
type CoinEntry = { id: string; symbol?: string; origin: CoinOrigin }

/** one row of CoinGecko's `search/trending` answer, kept only as long as it stays useful (see `trendingRaw`) */
type TrendingHit = { id: string; symbol: string }

// bitcoin/ethereum/solana/hyperliquid are the four coins that always stay on
// the board - the id is what CoinGecko keys its answer by, and `symbol` is
// left unset so the board takes CoinGecko's own `symbol` field (already
// BTC/ETH/SOL/HYPE for these four) rather than duplicating it here.
const DEFAULT_FIXED_COINS: CoinConfig[] = [
  { id: 'bitcoin' },
  { id: 'ethereum' },
  { id: 'solana' },
  { id: 'hyperliquid' },
]

type QuoteRow = {
  id: string
  symbol: string
  origin: CoinOrigin
  price: number
  pct1h: number
  pct24h: number
  volume24h: number
  was?: { price: number; pct1h: number; pct24h: number; volume24h: number; id?: string; symbol?: string }
}

type Config = {
  /** how often this module re-reads crypto-band.json and re-renders; does not touch CoinGecko */
  refreshMs: number
  /** seconds between CoinGecko coins/markets requests, in ms; clamped to FEED_MS_MIN and up */
  feedMs: number
  sort: SortKey
  highlight: boolean
  /** how long one page holds before the board turns; 0 = manual only (no 翻頁 auto-advance) */
  pageMs: number
  /** `full` flaps and steps the live dot; `off` leaves the board still and repaints once a second for the countdown */
  animation: 'full' | 'off'
  countdown: boolean
  /** coins that are always on the board, regardless of what is trending */
  fixedCoins: CoinConfig[]
  /** whether the rest of the table is filled from CoinGecko's trending list */
  trendingEnabled: boolean
  /** how many trending coins (after excludedCoins/fixedCoins de-dup) to keep, out of the up-to-15 the API answers */
  trendingLimit: number
  /** how often the trending list itself is refreshed, in ms; clamped to TRENDING_MS_MIN and up - unrelated to feedMs */
  trendingRefreshMs: number
  /** tickers (e.g. stablecoins) that never count as "trending", matched case-insensitively */
  excludedCoins: string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    return asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

/** `fixedCoins` in crypto-band.json: an array of CoinGecko ids, either bare strings or `{id, symbol}` objects */
function parseFixedCoins(value: unknown): CoinConfig[] {
  if (!Array.isArray(value)) return DEFAULT_FIXED_COINS
  const out: CoinConfig[] = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      if (raw) out.push({ id: raw })
    } else {
      const entry = asRecord(raw)
      const id = str(entry?.id, '')
      if (!id) continue
      const symbol = typeof entry?.symbol === 'string' && entry.symbol ? entry.symbol.toUpperCase() : undefined
      out.push({ id, ...(symbol ? { symbol } : {}) })
    }
    if (out.length >= MAX_FIXED_COINS) break
  }
  return out.length > 0 ? out : DEFAULT_FIXED_COINS
}

/** `excludedCoins` in crypto-band.json: tickers, not CoinGecko ids - trending items are matched by their `symbol` */
function parseExcludedCoins(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_EXCLUDED_COINS
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw === 'string' && raw.trim()) out.push(raw.trim().toUpperCase())
  }
  return out.length > 0 ? out : DEFAULT_EXCLUDED_COINS
}

function defaultConfig(): Config {
  return {
    refreshMs: DEFAULT_REFRESH_MS,
    feedMs: FEED_MS_DEFAULT,
    sort: 'change24h',
    highlight: true,
    pageMs: PAGE_MS_DEFAULT,
    animation: 'full',
    countdown: true,
    fixedCoins: DEFAULT_FIXED_COINS,
    trendingEnabled: true,
    trendingLimit: TRENDING_LIMIT_DEFAULT,
    trendingRefreshMs: TRENDING_MS_DEFAULT,
    excludedCoins: DEFAULT_EXCLUDED_COINS,
  }
}

/** turns one parsed crypto-band.json root into a Config, filling in defaultConfig() for every key the file does not set */
function parseConfigRoot(root: Record<string, unknown> | undefined): Config {
  const cfg = defaultConfig()
  if (!root) return cfg
  cfg.refreshMs = Math.max(1000, num(root.refreshMs, cfg.refreshMs))
  cfg.feedMs = Math.max(FEED_MS_MIN, num(root.feedMs, cfg.feedMs))
  if (root.sort === 'change24h' || root.sort === 'change1h' || root.sort === 'volume' || root.sort === 'list') {
    cfg.sort = root.sort
  }
  if (root.highlight === false) cfg.highlight = false
  const pageMs = num(root.pageMs, cfg.pageMs)
  cfg.pageMs = pageMs <= 0 ? 0 : Math.max(PAGE_MS_MIN, pageMs)
  if (root.animation === 'off' || root.animation === false) cfg.animation = 'off'
  if (root.countdown === false) cfg.countdown = false
  if (root.fixedCoins !== undefined) cfg.fixedCoins = parseFixedCoins(root.fixedCoins)
  if (typeof root.trendingEnabled === 'boolean') cfg.trendingEnabled = root.trendingEnabled
  cfg.trendingLimit = Math.max(1, Math.min(TRENDING_LIMIT_MAX, Math.round(num(root.trendingLimit, cfg.trendingLimit))))
  cfg.trendingRefreshMs = Math.max(TRENDING_MS_MIN, num(root.trendingRefreshMs, cfg.trendingRefreshMs))
  if (root.excludedCoins !== undefined) cfg.excludedCoins = parseExcludedCoins(root.excludedCoins)
  return cfg
}

/** how often coins/markets is polled, whatever the combined fixed+trending coin count - CoinGecko answers the whole `ids` list in one call */
function feedInterval(cfg: Config): number {
  return Math.max(cfg.feedMs, FEED_MS_MIN)
}

type MarketsRow = { price: number; pct1h: number; pct24h: number; volume24h: number; symbol: string }

/** the `coins/markets` answer, keyed by CoinGecko id; a row missing a usable price is dropped */
function parseMarkets(text: string): Record<string, MarketsRow> {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return {}
  }
  if (!Array.isArray(body)) return {}
  const out: Record<string, MarketsRow> = {}
  for (const raw of body) {
    const row = asRecord(raw)
    if (!row) continue
    const id = str(row.id, '')
    const price = num(row.current_price, NaN)
    if (!id || !Number.isFinite(price)) continue
    out[id] = {
      price,
      pct1h: num(row.price_change_percentage_1h_in_currency, 0),
      pct24h: num(row.price_change_percentage_24h_in_currency, num(row.price_change_percentage_24h, 0)),
      volume24h: num(row.total_volume, 0),
      symbol: str(row.symbol, id).toUpperCase(),
    }
  }
  return out
}

/**
 * The `search/trending` answer, ranked as CoinGecko returns it. Returns
 * `undefined` only on a genuine parse failure (bad JSON, or no `coins`
 * array at all) - an empty array is a legitimate "nothing trending" answer,
 * not a failure, and must not trigger the "keep the last good list" path.
 */
function parseTrending(text: string): TrendingHit[] | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  const root = asRecord(body)
  const list = root?.coins
  if (!Array.isArray(list)) return undefined
  const out: TrendingHit[] = []
  for (const raw of list) {
    const entry = asRecord(raw)
    const item = entry ? asRecord(entry.item) : undefined
    const id = str(item?.id, '')
    if (!id) continue
    out.push({ id, symbol: str(item?.symbol, id).toUpperCase() })
  }
  return out
}

/**
 * Filtering (fixed-coin de-dup, excludedCoins, trendingLimit) is applied
 * here, at merge time, off the raw ranked list from the last successful
 * `search/trending` fetch - not baked into `trendingRaw` itself. That way a
 * config change to fixedCoins/excludedCoins/trendingLimit takes effect on
 * the next render instead of waiting for the next 10-minute trending poll.
 */
function selectTrending(raw: TrendingHit[], fixedIds: Set<string>, excluded: Set<string>, limit: number): TrendingHit[] {
  const out: TrendingHit[] = []
  const seen = new Set<string>()
  for (const hit of raw) {
    if (out.length >= limit) break
    if (fixedIds.has(hit.id) || seen.has(hit.id) || excluded.has(hit.symbol)) continue
    seen.add(hit.id)
    out.push(hit)
  }
  return out
}

// --- module state (memory only: a fresh session starts unsnoozed) ----------
let ready = false
let config: Config = defaultConfig()
// the last known-good row per coin, in activeCoins() order - NEVER cleared
// on a failed fetch (see feedOnce/backOff): this is the "last successful
// data" requirement asks for.
let quotes: QuoteRow[] = []
let lastUpdateAt = 0 // epoch ms of the last SUCCESSFUL coins/markets fetch; 0 = never
let feedHealthy = true // false from the moment a fetch fails until the next one succeeds
let feedSeq = 0 // bumped once per successful fetch; the board's live dot steps on it
let feedFailures = 0
let feedSkipUntil = 0
let feedInFlight = false
let nextFeedAt = 0
let unmappedWarned = false // this session's one-time "CoinGecko has no data for ..." log
let version = ''
let snoozedUntil = 0
let sortOverride: SortKey | undefined // set by the 排序 button; undefined = config.sort

// the last successful `search/trending` answer, ranked, before any
// fixedCoins/excludedCoins/trendingLimit filtering - NEVER cleared on a
// failed fetch, and empty (not fabricated) until the first one succeeds, so
// a first-launch trending failure just leaves the board on fixed coins only.
let trendingRaw: TrendingHit[] = []
let trendingInFlight = false

// --- paging ------------------------------------------------------------
let page = 0
let pageAt = 0
let lastShown: QuoteRow[] = []
let pageFrom: QuoteRow[] | undefined
let pageFromAt = 0
let turnSeq = 0
let lastPageCount = 1

function pageCount(): number {
  return lastPageCount
}

function setPage(nextPage: number, now: number) {
  if (nextPage === page) return
  pageFrom = lastShown
  pageFromAt = now
  pageAt = now
  page = nextPage
  turnSeq += 1
}

/** turns the page when the one on the board has held for `pageMs`, riding the config poll rather than a timer of its own - see setPage */
function autoPage(now: number) {
  if (config.pageMs <= 0) return
  if (now < snoozedUntil || pageCount() < 2) {
    pageAt = now
    return
  }
  if (pageAt === 0) {
    pageAt = now
    return
  }
  if (now - pageAt < config.pageMs) return
  setPage((page + 1) % pageCount(), now)
}

/** fixedCoins, plus (if enabled) the current trending selection, de-duped by coin id - fixed coins always win a collision */
function activeCoins(): CoinEntry[] {
  const fixed: CoinEntry[] = config.fixedCoins.map(c => ({ id: c.id, symbol: c.symbol, origin: 'fixed' as const }))
  if (!config.trendingEnabled) return fixed
  const fixedIds = new Set(fixed.map(c => c.id))
  const excluded = new Set(config.excludedCoins)
  const trending = selectTrending(trendingRaw, fixedIds, excluded, config.trendingLimit)
  return [...fixed, ...trending.map(t => ({ id: t.id, symbol: t.symbol, origin: 'trending' as const }))]
}

type BoardProps = {
  quotes: QuoteRow[]
  sortKey: SortKey
  sorted: boolean
  highlight: boolean
  page: number
  pageCount: number
  turn: number
  seq: number
  stale: boolean
  lastUpdateAt: number
  nextFeedAt: number
  animation: 'full' | 'off'
  countdown: boolean
  now: number
  version: string
}

/**
 * Sorts, pages, and works out which visible rows just turned - either the
 * whole page (a page or sort change, within PAGE_TURN_WINDOW_MS) or just the
 * rows whose coin changed occupant (a rank cross with no accompanying page
 * turn, e.g. two coins swapping places under the 24h% sort, or the trending
 * list rotating a coin out from under a page). Ported from tw-stock-mod's
 * buildProps, stripped of everything market/session-specific.
 */
function buildProps(now: number): BoardProps {
  const sortKey = sortOverride ?? config.sort
  const ranked = [...quotes]
  if (sortKey === 'change24h') ranked.sort((a, b) => b.pct24h - a.pct24h)
  else if (sortKey === 'change1h') ranked.sort((a, b) => b.pct1h - a.pct1h)
  else if (sortKey === 'volume') ranked.sort((a, b) => b.volume24h - a.volume24h)
  // 'list': no sort - `quotes` is already in activeCoins() order

  const pages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE))
  lastPageCount = pages
  const pageIdx = ((page % pages) + pages) % pages
  const shown = ranked.slice(pageIdx * PAGE_SIZE, pageIdx * PAGE_SIZE + PAGE_SIZE)

  const wasOf = (before: QuoteRow) => ({
    price: before.price,
    pct1h: before.pct1h,
    pct24h: before.pct24h,
    volume24h: before.volume24h,
    id: before.id,
    symbol: before.symbol,
  })

  if (pageFrom && now - pageFromAt < PAGE_TURN_WINDOW_MS) {
    // A page/sort change turns every visible row at once, whether or not its
    // own price moved - a real board flaps the whole page together.
    for (let i = 0; i < shown.length; i++) {
      const before = pageFrom[i]
      if (before) shown[i] = { ...shown[i], was: wasOf(before) }
    }
  } else {
    // No page turn is running, but a row's OCCUPANT can still change: with
    // `sortKey !== 'list'` the list re-sorts every render, so two coins
    // crossing rank (or the trending list swapping one coin for another)
    // moves a new coin into a slot with no page turn to explain it.
    // Comparing this render's row at position i against what `lastShown`
    // actually drew there catches that. A row whose occupant did NOT change
    // keeps whatever price-only `was` applyQuotes already attached (see
    // feedOnce), so a price update and a rank cross can both turn the same
    // row without stepping on each other.
    let ranksCrossed = false
    for (let i = 0; i < shown.length; i++) {
      const before = lastShown[i]
      if (!before || before.id === shown[i].id) continue
      shown[i] = { ...shown[i], was: wasOf(before) }
      ranksCrossed = true
    }
    if (ranksCrossed) turnSeq += 1
  }
  lastShown = shown

  return {
    quotes: shown,
    sortKey,
    sorted: sortKey !== 'list',
    highlight: config.highlight,
    page: pageIdx,
    pageCount: pages,
    turn: turnSeq,
    seq: feedSeq,
    stale: !feedHealthy,
    lastUpdateAt,
    nextFeedAt,
    animation: config.animation,
    countdown: config.countdown,
    now,
    version,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, doNext) => {
    const r = await doNext(e)

    try {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
      if (typeof manifest?.version === 'string') version = `v${manifest.version}`
    } catch {
      // a band that cannot name its version still draws prices
    }

    // A missing config file is normal (every key has a default) - the host
    // logs every failed $.fs.read at ERROR level, so polling it every few
    // seconds would fill a new user's debug log with one error a tick. A
    // missing file is retried every MISS_EVERY ticks instead; the counter
    // resets the moment it turns up.
    const MISS_EVERY = 10
    let configMisses = 0
    const readConfig = async (): Promise<string | undefined> => {
      if (configMisses > 0 && configMisses % MISS_EVERY !== 0) {
        configMisses += 1
        return undefined
      }
      try {
        const text = await $.fs.read(CONFIG_PATH)
        configMisses = 0
        return text
      } catch {
        configMisses += 1
        return undefined
      }
    }

    const poll = async () => {
      const now = await $.clock.now()
      config = parseConfigRoot(parseJsonRecord(await readConfig()))
      ready = true
      autoPage(now)
      // redraw while snoozed too, so the collapsed row's countdown ticks down
      $.ui.invalidate('ui.render')
    }

    // once immediately so the band is there on the first prompt, then on the
    // refresh interval the config asked for. The interval is fixed for the
    // session: changing refreshMs later needs /reload-plugins - same
    // limitation feedMs and trendingRefreshMs have below.
    await poll().catch(err => $.ui.log(`crypto-band-mod: poll failed: ${err}`))
    $.clock.every(config.refreshMs, () => {
      poll().catch(err => $.ui.log(`crypto-band-mod: poll failed: ${err}`))
    })

    // A failed request must never become a made-up price: quotes/lastUpdateAt
    // are only ever touched by a SUCCESSFUL fetch (see applyQuotes below).
    // This just marks the last attempt as failed, backs off exponentially
    // (capped), and lets the board say 資料延遲 off `feedHealthy`.
    const backOff = (now: number, why: string) => {
      feedFailures += 1
      feedHealthy = false
      const wait = Math.min(feedInterval(config) * 2 ** feedFailures, FEED_BACKOFF_MAX_MS)
      feedSkipUntil = now + wait
      nextFeedAt = now + wait
      $.ui.log(`crypto-band-mod: feed ${why}, next try in ${Math.round(wait / 1000)}s`)
      $.ui.invalidate('ui.render')
    }

    /** merges a successful CoinGecko answer into `quotes`, activeCoins() order, carrying `was` for whatever coin's price actually moved */
    const applyQuotes = (parsed: Record<string, MarketsRow>, coins: CoinEntry[]) => {
      const next: QuoteRow[] = []
      const unmapped: string[] = []
      for (const coin of coins) {
        const p = parsed[coin.id]
        const prevRow = quotes.find(q => q.id === coin.id)
        if (!p) {
          // CoinGecko answered but not for this id - keep whatever this
          // module already had for it (never blank a row that used to have
          // a price) and warn once so a typo'd id gets noticed.
          if (prevRow) next.push(prevRow)
          else unmapped.push(coin.id)
          continue
        }
        const symbol = coin.symbol ?? p.symbol
        const changed = !prevRow || prevRow.price !== p.price
        next.push({
          id: coin.id,
          symbol,
          origin: coin.origin,
          price: p.price,
          pct1h: p.pct1h,
          pct24h: p.pct24h,
          volume24h: p.volume24h,
          ...(changed && prevRow
            ? { was: { price: prevRow.price, pct1h: prevRow.pct1h, pct24h: prevRow.pct24h, volume24h: prevRow.volume24h } }
            : {}),
        })
      }
      quotes = next
      if (unmapped.length > 0 && !unmappedWarned) {
        unmappedWarned = true
        $.ui.log(`crypto-band-mod: CoinGecko has no data for ${unmapped.join(', ')} - check the coin id in ${CONFIG_PATH}`)
      }
    }

    const feedOnce = async (now: number) => {
      const coins = activeCoins()
      const ids = coins.map(c => c.id)
      if (ids.length === 0) return
      const url = `${COINGECKO_MARKETS_URL}?vs_currency=usd&ids=${encodeURIComponent(ids.join(','))}&price_change_percentage=1h,24h&_=${now}`
      let res: { ok: boolean; status: number; text: string }
      try {
        res = await $.http.fetch(url)
      } catch (err) {
        backOff(now, `network error (${err})`)
        return
      }
      if (!res.ok) {
        backOff(now, `HTTP ${res.status}`)
        return
      }
      const parsed = parseMarkets(res.text)
      if (Object.keys(parsed).length === 0) {
        backOff(now, 'answered nothing usable')
        return
      }
      feedFailures = 0
      feedHealthy = true
      lastUpdateAt = now
      feedSeq += 1
      turnSeq += 1
      nextFeedAt = now + feedInterval(config)
      applyQuotes(parsed, coins)
      $.ui.invalidate('ui.render')
    }

    const feed = async () => {
      const now = await $.clock.now()
      // Snoozed means the table is not on screen at all, so the 30 minutes
      // it covers need no prices; feedSkipUntil is a 429/error backoff;
      // feedInFlight keeps a slow answer from stacking a second request.
      if (now < snoozedUntil || now < feedSkipUntil || feedInFlight) return
      feedInFlight = true
      try {
        await feedOnce(now)
      } finally {
        feedInFlight = false
      }
    }

    await feed().catch(err => $.ui.log(`crypto-band-mod: feed failed: ${err}`))
    $.clock.every(feedInterval(config), () => {
      feed().catch(err => $.ui.log(`crypto-band-mod: feed failed: ${err}`))
    })

    // The trending list rides its own, much slower clock - "熱門名單每 10
    // 分鐘更新一次，不可每次 UI 重繪都請求 API": a UI redraw (buildProps) or
    // even a coins/markets tick never triggers a `search/trending` request,
    // only this timer does. A failed attempt just leaves `trendingRaw` (and
    // therefore the board) exactly as it was - see parseTrending's contract.
    const trendingFeedOnce = async () => {
      let res: { ok: boolean; status: number; text: string }
      try {
        res = await $.http.fetch(COINGECKO_TRENDING_URL)
      } catch (err) {
        $.ui.log(`crypto-band-mod: trending feed network error (${err}), keeping last trending list`)
        return
      }
      if (!res.ok) {
        $.ui.log(`crypto-band-mod: trending feed HTTP ${res.status}, keeping last trending list`)
        return
      }
      const parsed = parseTrending(res.text)
      if (!parsed) {
        $.ui.log('crypto-band-mod: trending feed answered nothing usable, keeping last trending list')
        return
      }
      trendingRaw = parsed
      $.ui.invalidate('ui.render')
    }

    const trendingFeed = async () => {
      if (!config.trendingEnabled) return
      const now = await $.clock.now()
      if (now < snoozedUntil || trendingInFlight) return
      trendingInFlight = true
      try {
        await trendingFeedOnce()
      } finally {
        trendingInFlight = false
      }
    }

    await trendingFeed().catch(err => $.ui.log(`crypto-band-mod: trending feed failed: ${err}`))
    $.clock.every(config.trendingRefreshMs, () => {
      trendingFeed().catch(err => $.ui.log(`crypto-band-mod: trending feed failed: ${err}`))
    })

    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, doNext) => {
    if (e.props.hasSurvey || e.surface !== 'terminal') return doNext(e)
    const now = await $.clock.now()
    if (!ready) return doNext(e)

    const { Box, Button, Client, Text } = await $.ui.resolve(e)

    // Snoozing used to drop the band with no way back; leave one row behind
    // that says how long is left and brings the table back.
    if (now < snoozedUntil) {
      const mins = Math.max(1, Math.ceil((snoozedUntil - now) / 60_000))
      const onWake = () => {
        snoozedUntil = 0
        $.ui.invalidate('ui.render')
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="crypto-band:wake" label={`幣圈列 ${mins}分 展開`} onPress={onWake} />
          </Box>
          {await doNext(e)}
        </Box>
      )
    }

    const props = buildProps(now)

    const onPage = () => {
      setPage((props.page + 1) % props.pageCount, now)
      $.ui.invalidate('ui.render')
    }
    // Cycles the four sort keys in a fixed order, flapping every visible row
    // in - the same page-turn flap the paging button triggers (setPage),
    // reused here since a sort change re-orders the whole page exactly the
    // way a page turn replaces it.
    const SORT_ORDER: SortKey[] = ['change24h', 'change1h', 'volume', 'list']
    const onSort = () => {
      const idx = SORT_ORDER.indexOf(props.sortKey)
      sortOverride = SORT_ORDER[(idx + 1) % SORT_ORDER.length]
      pageFrom = lastShown
      pageFromAt = now
      turnSeq += 1
      $.ui.invalidate('ui.render')
    }
    const onSnooze = () => {
      snoozedUntil = now + SNOOZE_MS
      $.ui.invalidate('ui.render')
    }

    const SORT_LABELS: Record<SortKey, string> = { change24h: '24h%', change1h: '1h%', volume: '成交量', list: '預設' }

    // No hotkeys, same reasoning tw-stock-mod's board settled on: a letter
    // hotkey only fires once one of these Buttons already holds the focus
    // ring, which buys nothing over pressing Enter once it is there.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color={DIM}>加密貨幣 · 24 小時</Text>
          </Box>
          <Box flexDirection="row">
            {props.pageCount > 1 ? (
              <Button key="crypto-band:page" label={`翻頁 ${props.page + 1}/${props.pageCount}`} onPress={onPage} />
            ) : null}
            <Button key="crypto-band:sort" label={`排序 ${SORT_LABELS[props.sortKey]}`} onPress={onSort} />
            <Button key="crypto-band:snooze" label="收起 30分" onPress={onSnooze} />
          </Box>
        </Box>
        <Client key="crypto-band:table" module="./board.tsx" width={e.viewport?.columns ?? e.props.bodyColumns ?? 80} height={TABLE_BOARD_ROWS} props={{ ...props }} />
        {await doNext(e)}
      </Box>
    )
  })
}
