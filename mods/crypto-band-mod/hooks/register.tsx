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
// once. A failed request NEVER produces a made-up price: the board keeps
// the last successful snapshot on screen and flags it 資料延遲 (see
// `feedHealthy` and BoardProps.stale in board.tsx) until a request
// succeeds again. There is no demo-price fallback anywhere in this module.
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
const PAGE_SIZE_1COL = 5
const PAGE_SIZE_2COL = 10
const PAGE_MS_DEFAULT = 10_000
const PAGE_MS_MIN = 4000
const PAGE_TURN_WINDOW_MS = 2500 // how long after a page/sort turn the outgoing rows are still worth turning from
const TABLE_BOARD_ROWS = 8
const MAX_COINS = 30
const DIM = '#6e7681'

// CoinGecko's free `coins/markets` endpoint - no API key needed (verified
// 2026-09-19, HTTP 200 with no auth header). `price_change_percentage=1h,24h`
// is what adds the `_in_currency` 1h/24h fields on top of the default
// 24h-only one; `total_volume` and `current_price` are already in the base
// response. One request covers every configured coin - CoinGecko does not
// impose the "20 symbols per request" cap Yahoo's spark endpoint does, so
// there is no batching to do here.
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets'

type SortKey = 'change24h' | 'change1h' | 'volume' | 'list'
type ColumnMode = 'auto' | 1 | 2

/** a config entry: a CoinGecko coin id, plus an optional display override for its ticker */
type CoinConfig = { id: string; symbol?: string }

// bitcoin/ethereum/solana/hyperliquid are the four v1 tracks; the id is what
// CoinGecko keys its answer by, and `symbol` is left unset so the board
// takes CoinGecko's own `symbol` field (already BTC/ETH/SOL/HYPE for these
// four) rather than duplicating it here.
const DEFAULT_COINS: CoinConfig[] = [
  { id: 'bitcoin' },
  { id: 'ethereum' },
  { id: 'solana' },
  { id: 'hyperliquid' },
]

type QuoteRow = {
  id: string
  symbol: string
  price: number
  pct1h: number
  pct24h: number
  volume24h: number
  was?: { price: number; pct1h: number; pct24h: number; volume24h: number; id?: string; symbol?: string }
}

type Config = {
  /** how often this module re-reads crypto-band.json and re-renders; does not touch CoinGecko */
  refreshMs: number
  /** seconds between CoinGecko requests, in ms; clamped to FEED_MS_MIN and up */
  feedMs: number
  sort: SortKey
  highlight: boolean
  /** how many coins the table draws per row; "auto" picks 1 for <=5 coins, 2 for more - see effectiveColumns */
  columns: ColumnMode
  /** how long one page holds before the board turns; 0 = manual only (no 翻頁 auto-advance) */
  pageMs: number
  /** `full` flaps and steps the live dot; `off` leaves the board still and repaints once a second for the countdown */
  animation: 'full' | 'off'
  countdown: boolean
  coins: CoinConfig[]
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

/** `coins` in crypto-band.json: an array of CoinGecko ids, either bare strings or `{id, symbol}` objects */
function parseCoins(value: unknown): CoinConfig[] {
  if (!Array.isArray(value)) return DEFAULT_COINS
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
    if (out.length >= MAX_COINS) break
  }
  return out.length > 0 ? out : DEFAULT_COINS
}

function defaultConfig(): Config {
  return {
    refreshMs: DEFAULT_REFRESH_MS,
    feedMs: FEED_MS_DEFAULT,
    sort: 'change24h',
    highlight: true,
    columns: 'auto',
    pageMs: PAGE_MS_DEFAULT,
    animation: 'full',
    countdown: true,
    coins: DEFAULT_COINS,
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
  if (root.columns === 1 || root.columns === 2 || root.columns === 'auto') cfg.columns = root.columns
  const pageMs = num(root.pageMs, cfg.pageMs)
  cfg.pageMs = pageMs <= 0 ? 0 : Math.max(PAGE_MS_MIN, pageMs)
  if (root.animation === 'off' || root.animation === false) cfg.animation = 'off'
  if (root.countdown === false) cfg.countdown = false
  if (root.coins !== undefined) cfg.coins = parseCoins(root.coins)
  return cfg
}

/** how many requests-per-second this session may spend: always 1 per tick, whatever the coin list holds - CoinGecko answers the whole `ids` list in one call */
function feedInterval(cfg: Config): number {
  return Math.max(cfg.feedMs, FEED_MS_MIN)
}

/** resolves `"auto"` off the watchlist length; an explicit 1/2 always wins */
function effectiveColumns(cfg: Config, listLength: number): 1 | 2 {
  if (cfg.columns === 1 || cfg.columns === 2) return cfg.columns
  return listLength > PAGE_SIZE_1COL ? 2 : 1
}
function pageSize(columns: 1 | 2): number {
  return columns === 2 ? PAGE_SIZE_2COL : PAGE_SIZE_1COL
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

// --- module state (memory only: a fresh session starts unsnoozed) ----------
let ready = false
let config: Config = defaultConfig()
// the last known-good row per coin, in config.coins order - NEVER cleared on
// a failed fetch (see feedOnce/backOff): this is the "last successful data"
// requirement 10 asks for.
let quotes: QuoteRow[] = []
let lastUpdateAt = 0 // epoch ms of the last SUCCESSFUL fetch; 0 = never
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

type BoardProps = {
  quotes: QuoteRow[]
  columns: 1 | 2
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
 * turn, e.g. two coins swapping places under the 24h% sort). Ported from
 * tw-stock-mod's buildProps, stripped of everything market/session-specific.
 */
function buildProps(now: number): BoardProps {
  const sortKey = sortOverride ?? config.sort
  const ranked = [...quotes]
  if (sortKey === 'change24h') ranked.sort((a, b) => b.pct24h - a.pct24h)
  else if (sortKey === 'change1h') ranked.sort((a, b) => b.pct1h - a.pct1h)
  else if (sortKey === 'volume') ranked.sort((a, b) => b.volume24h - a.volume24h)
  // 'list': no sort - `quotes` is already in config.coins order

  const columns = effectiveColumns(config, ranked.length)
  const perPage = pageSize(columns)
  const pages = Math.max(1, Math.ceil(ranked.length / perPage))
  lastPageCount = pages
  const pageIdx = ((page % pages) + pages) % pages
  const shown = ranked.slice(pageIdx * perPage, pageIdx * perPage + perPage)

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
    // crossing rank moves one of them into a slot with no page turn to
    // explain it. Comparing this render's row at position i against what
    // `lastShown` actually drew there catches that. A row whose occupant did
    // NOT change keeps whatever price-only `was` applyQuotes already
    // attached (see feedOnce), so a price update and a rank cross can both
    // turn the same row without stepping on each other.
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
    columns,
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
    // limitation feedMs has below.
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

    /** merges a successful CoinGecko answer into `quotes`, config.coins order, carrying `was` for whatever coin's price actually moved */
    const applyQuotes = (parsed: Record<string, MarketsRow>) => {
      const next: QuoteRow[] = []
      const unmapped: string[] = []
      for (const coin of config.coins) {
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
      const ids = config.coins.map(c => c.id)
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
      applyQuotes(parsed)
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

    const cols = e.viewport?.columns ?? e.props.bodyColumns ?? 80
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
        <Client key="crypto-band:table" module="./board.tsx" width={cols} height={TABLE_BOARD_ROWS} props={{ ...props }} />
        {await doNext(e)}
      </Box>
    )
  })
}
