/* @jsx h */
import type { Register } from 'claude-code'

// tw-stock-mod: a watchlist band above the Claude Code prompt. Taiwan trading
// hours show the Taiwan list, US trading hours show the US list, and the
// red/green convention flips with the market (台股紅漲綠跌 / 美股綠漲紅跌).
//
// This module never calls $.model.* and never touches the prompt: it computes
// the market session off $.clock.now(), builds a quote snapshot, and draws a
// Client board (hooks/board.tsx). Both markets are priced live by the feed
// below, each from its own source and each saying which in the footer: US
// quotes come from Yahoo's public endpoints, and so does Taiwan by default -
// Yahoo's Taiwan quotes run about twenty minutes behind, the tradeoff for a
// feed that answers with one request whatever the list length.
// `twSource: "mis"` switches Taiwan to the exchange's own real-time intraday
// endpoint instead. A market the feed cannot reach falls back to a
// deterministic sine walk off each symbol's previous close, and the footer
// then says 示範資料 rather than pretending.
// `.claude/stock-quotes.json` stays as the override seam (see
// stock-band.example.json and docs/stock-api-notes.md): a fresh file wins over
// the feed, which is how another fetcher can take the band over.
//
// Never name a local variable `h`: every JSX tag in this file compiles to h(...).

const CONFIG_PATH = '.claude/stock-band.json'
const QUOTES_PATH = '.claude/stock-quotes.json'
const HOLDINGS_PATH = '.claude/stock-holdings.json'
const DEFAULT_REFRESH_MS = 3000
const QUOTE_STALE_MS = 120_000
const SNOOZE_MS = 30 * 60 * 1000
// One symbol page in single-column mode, two in two-column mode (see
// `columns` below) - the table Client is 8 terminal rows either way, the
// chart one 9, whatever the list holds.
const PAGE_SIZE_1COL = 5
const PAGE_SIZE_2COL = 10
// Yahoo's spark endpoint answers `Number of symbols needs to be less than or
// equal to 20` above 20 symbols (measured 2026-09-16: 20 -> 200, 21 -> 400).
// That is a request-batching limit, not a watchlist-length one - `fetchSpark`
// already splits a longer symbol list into 20-symbol requests - but a list
// longer than Yahoo answers in two requests is not worth carrying, so this
// caps it there too.
const MAX_SYMBOLS = 20
const SPARK_BATCH = 20 // Yahoo's own per-request symbol cap
const PAGE_MS_DEFAULT = 10_000 // one page holds this long before the board turns
const PAGE_MS_MIN = 4000
// A budget, not an interval: `feedMs` alone cannot keep the host inside the
// limit once one tick costs more than one request. See feedInterval().
const REQUESTS_PER_HOUR = 300
const CHART_BARS = 40 // K bars the chart view asks for (it draws what fits)
const DEMO_BAR_MS = 3000 // demo time per fake bar; a real feed sets its own

// --- live feed --------------------------------------------------------------
// Yahoo's public endpoints, no key, no account. One batched spark request per
// tick covers the whole list plus the index, which is what keeps the feed
// inside the rate limit: a request with no browser User-Agent gets 429 on the
// first try, and a burst of per-symbol requests gets 429 as well. K bars cost
// one request per symbol, so nothing fetches them until the chart view asks
// for the one symbol it is drawing.
const FEED_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const FEED_MS_DEFAULT = 30_000
const FEED_MS_MIN = 15_000 // a floor, so a bad config cannot get the host banned
const FEED_BACKOFF_MAX_MS = 300_000
const BARS_MAX_AGE_MS = 120_000 // a 5-minute bar refetched sooner than this says nothing new
const BARS_STALE_MS = 900_000 // past this a bar set is dropped rather than drawn
const US_INDEX_SYMBOL = '^IXIC' // NASDAQ Composite, what MARKETS.us calls its index
// the three the US market is read by. They ride the same batched request as
// the quotes, so showing all three costs no extra call.
const US_INDICES: { symbol: string; name: string }[] = [
  // Latin names: the board flaps them character by character, and a Chinese
  // character has no drum to riffle through
  { symbol: '^DJI', name: 'DOW' },
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: US_INDEX_SYMBOL, name: 'NASDAQ' },
]

// `twSource: "mis"` sends Taiwan to the exchange instead of Yahoo. Both are
// keyless, but Yahoo's Taiwan quotes run about twenty minutes behind the
// floor (measured 2026-09-16: Yahoo answered 10:21:51 while MIS was on
// 10:41:59), and a band that says 即時 has to mean it - which is what `mis`
// is for. MIS takes the whole watchlist and both indices in one request
// whatever the list length, and has no 20-symbol cap of its own.
const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'
// 上市 / 上櫃. It decides the MIS channel prefix and the Yahoo suffix, and
// nothing else about a symbol tells them apart - 6488 is 上櫃, 2330 is 上市.
type TwExchange = 'tse' | 'otc'
const TW_INDEX_SYMBOL = 't00' // 發行量加權股價指數, what MARKETS.tw calls its index
// Latin names for the same reason the US ones are Latin: the board flaps one
// character at a time and a Chinese character has no drum to riffle through.
// they are named `code` rather than `symbol` so misChannel() takes them as-is
// MIS answers every index on the same request as the quotes, so the length of
// this list costs nothing. What it does cost is time on the footer: each row
// holds 5 s before the board flaps to the next, so four indices is a 20 s lap.
// `twIndices` in the config replaces the whole list - the exchange publishes
// 146 of them (getCategory.jsp?ex=tse&i=TIDX lists every channel).
const TW_INDICES: TwIndex[] = [
  { code: TW_INDEX_SYMBOL, name: 'TAIEX', ex: 'tse' }, // 發行量加權股價指數
  { code: 't24', name: 'SEMI', ex: 'tse' }, // 半導體類指數
  { code: 't17', name: 'FINANCE', ex: 'tse' }, // 金融保險類指數
  { code: 't15', name: 'SHIPPING', ex: 'tse' }, // 航運類指數
  // 櫃買 is { code: 'o00', name: 'TPEx', ex: 'otc' } - it needs the otc channel
]
const TW_YAHOO_INDEX = '^TWII' // the Yahoo route's only index; ^TWOII answers a year-old close

/** a footer index row on the MIS route; `code`/`ex` are what misChannel() reads */
type TwIndex = { code: string; name: string; ex: TwExchange }

type MarketId = 'tw' | 'us'
type Phase = 'open' | 'closed'
type MarketMode = 'auto' | MarketId
type View = 'table' | 'chart' | 'pnl'
/** how many symbols the table draws per row; "auto" picks off the page size, see effectiveColumns() */
type ColumnMode = 'auto' | 1 | 2

type Ticker = {
  code: string
  name: string
  /** 上市 tse (default) or 上櫃 otc; Taiwan only, and both price routes need it */
  ex?: TwExchange
  prevClose: number
  // demo-only price walk parameters (ignored once a quotes file drives the band)
  amp: number
  phase: number
  period: number
  drift: number
}

// prevClose is the change basis and, in demo mode, the level the fake walk
// oscillates around; amp/phase/period/drift only shape that fake walk and are
// ignored once a quotes file drives the band. All 20 prevClose values were
// read directly off Yahoo's spark endpoint on 2026-09-16 ~12:39 Taipei time
// and cross-checked against 證交所 MIS's own `y` field (exact match on every
// symbol) - refresh both if they drift. All twenty are 上市 (no otc symbol
// needed a `.TWO`/`otc_` route).
const TW_LIST: Ticker[] = [
  { code: '2330', name: '台積電', prevClose: 2385, amp: 0.9, phase: 0, period: 47, drift: 1.1 },
  { code: '2317', name: '鴻海', prevClose: 246.5, amp: 0.7, phase: 1.7, period: 61, drift: 0.35 },
  { code: '2454', name: '聯發科', prevClose: 4430, amp: 1.1, phase: 3.1, period: 53, drift: -0.6 },
  { code: '0050', name: '元大台灣50', prevClose: 106.25, amp: 0.4, phase: 0.8, period: 71, drift: 0.55 },
  { code: '006208', name: '富邦台50', prevClose: 243.5, amp: 0.35, phase: 2.4, period: 67, drift: -0.15 },
  { code: '2412', name: '中華電', prevClose: 143.5, amp: 0.25, phase: 0.5, period: 83, drift: 0.1 },
  { code: '2881', name: '富邦金', prevClose: 151.0, amp: 0.5, phase: 1.2, period: 57, drift: 0.2 },
  { code: '2882', name: '國泰金', prevClose: 110.0, amp: 0.5, phase: 2.0, period: 63, drift: -0.15 },
  { code: '2891', name: '中信金', prevClose: 69.7, amp: 0.45, phase: 2.8, period: 69, drift: 0.1 },
  { code: '3008', name: '大立光', prevClose: 6055, amp: 1.4, phase: 3.5, period: 41, drift: -0.8 },
  { code: '2603', name: '長榮', prevClose: 233.5, amp: 1.6, phase: 4.2, period: 39, drift: 1.0 },
  { code: '1301', name: '台塑', prevClose: 62.0, amp: 0.35, phase: 4.9, period: 77, drift: -0.2 },
  { code: '2002', name: '中鋼', prevClose: 18.65, amp: 0.3, phase: 5.5, period: 87, drift: 0.05 },
  { code: '2308', name: '台達電', prevClose: 1670, amp: 0.9, phase: 0.2, period: 49, drift: 0.5 },
  { code: '3711', name: '日月光投控', prevClose: 592.0, amp: 0.8, phase: 0.9, period: 52, drift: 0.3 },
  { code: '2379', name: '瑞昱', prevClose: 703.0, amp: 1.0, phase: 1.6, period: 45, drift: -0.4 },
  { code: '3034', name: '聯詠', prevClose: 541.0, amp: 0.95, phase: 2.3, period: 48, drift: 0.35 },
  { code: '2357', name: '華碩', prevClose: 928.0, amp: 0.7, phase: 3.0, period: 59, drift: -0.25 },
  { code: '2382', name: '廣達', prevClose: 333.0, amp: 1.3, phase: 3.7, period: 43, drift: 0.9 },
  { code: '2303', name: '聯電', prevClose: 138.5, amp: 0.6, phase: 4.4, period: 64, drift: -0.3 },
]

// Same field contract as TW_LIST above. All 20 prevClose values came off
// Yahoo's spark endpoint in one request on 2026-09-16 ~13:05 Taipei time
// (US market closed, so these are the 09-15 closes) - refresh them if the
// demo walk starts oscillating around the wrong level. NFLX is post-split.
const US_LIST: Ticker[] = [
  { code: 'NVDA', name: 'NVIDIA', prevClose: 210.96, amp: 1.3, phase: 0.4, period: 43, drift: 0.9 },
  { code: 'TSLA', name: 'Tesla', prevClose: 358.97, amp: 1.8, phase: 2.2, period: 37, drift: -1.2 },
  { code: 'NET', name: 'Cloudflare', prevClose: 330.36, amp: 1.5, phase: 4, period: 59, drift: 0.4 },
  { code: 'QQQ', name: 'Invesco QQQ', prevClose: 709.18, amp: 0.5, phase: 1.1, period: 73, drift: 0.25 },
  { code: 'VOO', name: 'Vanguard 500', prevClose: 699.3, amp: 0.4, phase: 3.6, period: 79, drift: -0.1 },
  { code: 'AAPL', name: 'Apple', prevClose: 333.08, amp: 0.7, phase: 0.9, period: 61, drift: 0.3 },
  { code: 'MSFT', name: 'Microsoft', prevClose: 505.41, amp: 0.6, phase: 1.6, period: 67, drift: -0.25 },
  { code: 'GOOGL', name: 'Alphabet', prevClose: 349.39, amp: 0.8, phase: 2.3, period: 55, drift: 0.45 },
  { code: 'AMZN', name: 'Amazon', prevClose: 253.54, amp: 0.85, phase: 3.0, period: 51, drift: -0.35 },
  { code: 'META', name: 'Meta', prevClose: 665.6, amp: 0.95, phase: 3.7, period: 47, drift: 0.5 },
  { code: 'AVGO', name: 'Broadcom', prevClose: 344.72, amp: 1.2, phase: 4.4, period: 45, drift: 0.7 },
  { code: 'AMD', name: 'AMD', prevClose: 493.41, amp: 1.4, phase: 5.1, period: 41, drift: 1.0 },
  { code: 'TSM', name: 'TSMC ADR', prevClose: 418.01, amp: 1.0, phase: 5.8, period: 49, drift: 0.6 },
  { code: 'NFLX', name: 'Netflix', prevClose: 80.32, amp: 0.9, phase: 0.2, period: 57, drift: -0.4 },
  { code: 'PLTR', name: 'Palantir', prevClose: 173.31, amp: 1.7, phase: 1.0, period: 39, drift: 0.85 },
  { code: 'COIN', name: 'Coinbase', prevClose: 191.45, amp: 2.0, phase: 1.9, period: 35, drift: -1.1 },
  { code: 'CRWD', name: 'CrowdStrike', prevClose: 235.38, amp: 1.3, phase: 2.7, period: 44, drift: 0.4 },
  { code: 'MU', name: 'Micron', prevClose: 924.03, amp: 1.6, phase: 3.4, period: 40, drift: 0.95 },
  { code: 'ORCL', name: 'Oracle', prevClose: 144.79, amp: 1.1, phase: 4.1, period: 53, drift: -0.5 },
  { code: 'ARM', name: 'Arm', prevClose: 239.01, amp: 1.25, phase: 4.8, period: 46, drift: 0.55 },
]

type MarketConf = {
  label: string
  list: Ticker[]
  hours: string
  indexName: string
  indexClose: number
  indexAmp: number
  indexDrift: number
  /** minutes from local midnight */
  open: number
  close: number
  offset: (now: number) => number
}

// Taipei is UTC+8 all year; US eastern is UTC-5, UTC-4 between the 2nd Sunday
// of March and the 1st Sunday of November. Doing the arithmetic here beats
// trusting a tz database to exist inside the hooks sandbox.
function usEasternOffset(now: number): number {
  const d = new Date(now)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  if (month < 3 || month > 11) return -5
  if (month > 3 && month < 11) return -4
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay() // 0 = Sunday
  const firstSunday = 1 + ((7 - firstDow) % 7)
  if (month === 3) return day >= firstSunday + 7 ? -4 : -5
  return day >= firstSunday ? -5 : -4
}

const MARKETS: Record<MarketId, MarketConf> = {
  tw: {
    label: '台股',
    list: TW_LIST,
    hours: '09:00-13:30',
    indexName: '加權指數',
    indexClose: 45862.52,
    indexAmp: 0.6,
    indexDrift: 0.75,
    open: 9 * 60,
    close: 13 * 60 + 30,
    offset: () => 8,
  },
  us: {
    label: '美股',
    list: US_LIST,
    hours: '09:30-16:00 ET',
    indexName: 'NASDAQ',
    indexClose: 26333.04,
    indexAmp: 0.5,
    indexDrift: -0.35,
    open: 9 * 60 + 30,
    close: 16 * 60,
    offset: usEasternOffset,
  },
}

type LocalParts = { dow: number; minutes: number; clock: string }

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function localParts(now: number, offsetHours: number): LocalParts {
  const d = new Date(now + offsetHours * 3_600_000)
  return {
    dow: d.getUTCDay(), // 0 = Sunday
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    clock: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`,
  }
}

const TAIPEI_OFFSET = 8 // UTC+8 all year, no daylight saving

function isWeekday(dow: number): boolean {
  return dow >= 1 && dow <= 5
}

// PROTOTYPE LIMIT: weekday-only. Taiwan and US market holidays (and the
// Taiwan make-up trading Saturdays) are not in here - a real feed's own
// "no trades today" answer is what should decide this later.
function phaseOf(now: number, market: MarketId): Phase {
  const conf = MARKETS[market]
  const { dow, minutes } = localParts(now, conf.offset(now))
  return isWeekday(dow) && minutes >= conf.open && minutes < conf.close ? 'open' : 'closed'
}

function minutesToOpen(now: number, market: MarketId): number {
  const conf = MARKETS[market]
  const { dow, minutes } = localParts(now, conf.offset(now))
  if (isWeekday(dow) && minutes < conf.open) return conf.open - minutes
  let days = 1
  let d = (dow + 1) % 7
  while (!isWeekday(d)) {
    days += 1
    d = (d + 1) % 7
  }
  return days * 1440 - minutes + conf.open
}

function minutesSinceClose(now: number, market: MarketId): number {
  const conf = MARKETS[market]
  const { dow, minutes } = localParts(now, conf.offset(now))
  if (isWeekday(dow) && minutes >= conf.close) return minutes - conf.close
  let days = 1
  let d = (dow + 6) % 7
  while (!isWeekday(d)) {
    days += 1
    d = (d + 6) % 7
  }
  return days * 1440 - conf.close + minutes
}

/** when this market last closed, as a timestamp - minutesSinceClose walks back
 * over the weekend for us, so this is a real moment on any day of the week */
function lastCloseAt(now: number, market: MarketId): number {
  return now - minutesSinceClose(now, market) * 60_000
}

function hhmm(minutesFromMidnight: number): string {
  return `${pad2(Math.floor(minutesFromMidnight / 60))}:${pad2(minutesFromMidnight % 60)}`
}

function sessionNote(now: number, market: MarketId, phase: Phase): string {
  const conf = MARKETS[market]
  const zone = MARKETS[market].offset(now) === TAIPEI_OFFSET ? '' : ' ET'
  if (phase === 'open') return conf.hours
  const mins = minutesToOpen(now, market)
  return mins <= 1440 ? `下次開盤 ${hhmm(conf.open)}${zone}` : `下個交易日 ${hhmm(conf.open)}${zone}`
}

// The person reading this band lives in Taipei, so US hours in ET answer the
// wrong question: 09:30 ET is 21:30 tonight, and the close lands after midnight.
// Returns '' for a market already on Taipei time, and the board drops the
// restatement rather than the clock when the row runs out of room.
function taipeiNote(now: number, market: MarketId, phase: Phase): string {
  const conf = MARKETS[market]
  if (conf.offset(now) === TAIPEI_OFFSET) return ''
  const shift = (TAIPEI_OFFSET - conf.offset(now)) * 60
  const at = (minutes: number) => hhmm((((minutes + shift) % 1440) + 1440) % 1440)
  return phase === 'open' ? `台灣 ${at(conf.open)}-${at(conf.close)}` : `台灣 ${at(conf.open)}`
}

const PREVIEW_MINS = 60 // how early a market takes the band over before it opens

// auto mode: whichever market is trading. Outside both sessions the band keeps
// showing the market that closed MOST RECENTLY - its closing prices are the
// news right after 13:30, not the other side of the world's pre-market - until
// the other market is within PREVIEW_MINS of its open.
function pickMarket(now: number, mode: MarketMode): { market: MarketId; phase: Phase } {
  if (mode !== 'auto') return { market: mode, phase: phaseOf(now, mode) }
  if (phaseOf(now, 'tw') === 'open') return { market: 'tw', phase: 'open' }
  if (phaseOf(now, 'us') === 'open') return { market: 'us', phase: 'open' }
  const twToOpen = minutesToOpen(now, 'tw')
  const usToOpen = minutesToOpen(now, 'us')
  const soonest = Math.min(twToOpen, usToOpen)
  if (soonest <= PREVIEW_MINS) return { market: twToOpen <= usToOpen ? 'tw' : 'us', phase: 'closed' }
  const market: MarketId = minutesSinceClose(now, 'tw') <= minutesSinceClose(now, 'us') ? 'tw' : 'us'
  return { market, phase: 'closed' }
}

// --- quotes ----------------------------------------------------------------
type Bar = [number, number, number, number] // open, high, low, close
type IndexRow = { name: string; value: number; change: number; pct: number }

type QuoteRow = {
  code: string
  name: string
  price: number
  change: number
  pct: number
  prevClose: number
  bars?: Bar[]
  /**
   * what this row said before the last update; absent when nothing moved.
   * `code`/`name` are only set when the whole row changed symbol - a page turn -
   * and they are what makes the board flap the left-hand columns as well.
   */
  was?: { price: number; change: number; pct: number; code?: string; name?: string }
  /**
   * the market has a live/override snapshot, but it never priced this code -
   * not the same as "no change" (pct 0). board.tsx draws a dim placeholder
   * instead of the price/change/pct fields; see buildProps' quotes.map.
   */
  noData?: boolean
}

// PROTOTYPE: a deterministic sine walk off the previous close, so the band
// moves on its own with no API and no randomness to debug.
function demoPrice(sym: Ticker, now: number): number {
  const t = now / 1000
  const pct =
    sym.drift +
    sym.amp * Math.sin((2 * Math.PI * t) / sym.period + sym.phase) +
    0.35 * sym.amp * Math.sin((2 * Math.PI * t) / (sym.period / 4.7) + sym.phase * 2.3)
  return Math.round(sym.prevClose * (1 + pct / 100) * 100) / 100
}

// a bar's high/low needs intra-bar movement the sine walk does not have, so a
// deterministic wiggle stands in for it
function demoBars(sym: Ticker, now: number, count: number): Bar[] {
  const bars: Bar[] = []
  for (let i = 0; i < count; i++) {
    const t1 = now - (count - 1 - i) * DEMO_BAR_MS
    const o = demoPrice(sym, t1 - DEMO_BAR_MS)
    const c = demoPrice(sym, t1)
    const mid = (o + c) / 2
    const span = Math.abs(c - o) / 2 + mid * 0.0008 * (1 + Math.sin((t1 / 1000) * 1.7 + sym.phase) ** 2)
    bars.push([o, Math.max(o, c) + span, Math.min(o, c) - span, c])
  }
  return bars
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function quoteRow(sym: Ticker, price: number, prevClose: number, bars?: Bar[], wasPrice?: number): QuoteRow {
  const change = round2(price - prevClose)
  // the old number measured against the same close, so only the price moved
  const wasChange = wasPrice === undefined ? 0 : round2(wasPrice - prevClose)
  return {
    code: sym.code,
    name: sym.name,
    price,
    change,
    pct: prevClose ? (change / prevClose) * 100 : 0,
    prevClose,
    // a Client's props must not hold undefined: the engine rejects the whole
    // tree and draws nothing. Rows without K bars omit the key instead.
    ...(bars ? { bars } : {}),
    // a row that did not move has nothing to turn, and turning it anyway is
    // noise: a real board only flaps what changed
    ...(wasPrice !== undefined && wasPrice !== price
      ? { was: { price: wasPrice, change: wasChange, pct: prevClose ? (wasChange / prevClose) * 100 : 0 } }
      : {}),
  }
}

// --- optional config / quotes files ----------------------------------------
type FileQuote = { price: number; prevClose?: number; name?: string; bars?: Bar[] }

// A holding as the holdings file or `stock-band.json`'s `holdings` block
// states it - `price`/`prevClose` are optional because the live feed usually
// covers them; `pricedHolding` below fills in whatever this leaves out.
type Holding = { code: string; name: string; qty: number; cost: number; price?: number; prevClose?: number }
// A holding once register.tsx has resolved a price for it - board.tsx (the
// 損益 view) only formats these, it never falls back to anything itself.
type PricedHolding = { code: string; name: string; qty: number; cost: number; price: number; prevClose: number }

type Config = {
  market: MarketMode
  refreshMs: number
  sort: 'change' | 'list'
  highlight: boolean
  /**
   * how many symbols the table draws per row. `auto` picks off the page size:
   * 5 or fewer draws the single-column table (代號/名稱/價格/變更$/變更%), 6 or
   * more draws two symbols a row (代號/名稱/價格/變更% only). The board itself
   * still falls back to 1 at render time if the terminal is too narrow for a
   * readable half.
   */
  columns: ColumnMode
  /**
   * which markets the live feed prices. `auto` follows the band, so only the
   * market on screen costs a request; `both` keeps the other side warm so a
   * market switch shows real prices at once. `off` leaves the band on demo
   * prices.
   */
  feed: 'auto' | 'us' | 'tw' | 'both' | 'off'
  /**
   * where Taiwan prices come from. `yahoo` (default) is one batched request,
   * ~20 minutes behind. `mis` is 證交所's own real-time snapshot, a backup
   * route for whoever wants exchange-true intraday without a broker account.
   * `shioaji` hands Taiwan to 永豐's real-time feed instead: the band spawns
   * `scripts/fetch-quotes-shioaji.py` itself (see spawnShioaji below) and
   * reads back the quotes file it writes, rather than calling an HTTP
   * endpoint the way the other two routes do.
   */
  twSource: 'mis' | 'yahoo' | 'shioaji'
  /** seconds between feed requests, in ms; clamped to FEED_MS_MIN and up */
  feedMs: number
  /** how long one page of the watchlist holds before the board turns; 0 = manual only */
  pageMs: number
  /** the indices the footer flaps through on the Taiwan board (MIS route only) */
  twIndices: TwIndex[]
  /**
   * `full` flaps and blinks on a 50 ms frame clock; `off` leaves the board
   * still and repaints once a second for the countdown (and not at all if the
   * countdown is off too). See docs: the measured cost of each is in the README.
   */
  animation: 'full' | 'off'
  /** show how many seconds until the next feed request */
  countdown: boolean
  lists: Record<MarketId, Ticker[]>
  /** `twSource: "shioaji"` only - how the band runs the fetcher script itself */
  shioaji: ShioajiConfig
  /**
   * manual holdings, keyed by market - the alternative to
   * `.claude/stock-holdings.json` (which wins for whichever market it names).
   * See parseHoldings and the README's 損益 section.
   */
  holdings: Record<MarketId, Holding[]>
}

type ShioajiConfig = {
  /** interpreter to run the script with, e.g. the project's own venv python */
  python: string
  /** env file holding SINOBON_API_KEY / SINOBON_SECRET_KEY; `~` expands to $HOME */
  env: string
  /** seconds between snapshots the script writes */
  interval: number
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

// a config entry only has to carry `code`; everything else falls back to the
// built-in symbol of the same code, then to a plain default
function parseList(value: unknown, builtin: Ticker[]): Ticker[] {
  if (!Array.isArray(value)) return builtin
  const out: Ticker[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (!entry) continue
    const code = str(entry.code, '')
    if (!code) continue
    const base = builtin.find(s => s.code === code)
    const ex = entry.ex === 'otc' || entry.ex === 'tse' ? entry.ex : base?.ex
    out.push({
      code,
      ...(ex ? { ex } : {}),
      name: str(entry.name, base?.name ?? code),
      prevClose: num(entry.prevClose, base?.prevClose ?? 100),
      amp: num(entry.amp, base?.amp ?? 0.8),
      phase: num(entry.phase, base?.phase ?? 0),
      period: num(entry.period, base?.period ?? 57),
      drift: num(entry.drift, base?.drift ?? 0),
    })
    // a longer list cannot be priced in one batched request, so it is cut here
    // rather than silently half-fed further down
    if (out.length >= MAX_SYMBOLS) break
  }
  return out.length > 0 ? out : builtin
}

function defaultConfig(): Config {
  return {
    market: 'auto',
    refreshMs: DEFAULT_REFRESH_MS,
    sort: 'change',
    highlight: true,
    columns: 'auto',
    feed: 'auto',
    twSource: 'yahoo',
    feedMs: FEED_MS_DEFAULT,
    pageMs: PAGE_MS_DEFAULT,
    twIndices: TW_INDICES,
    animation: 'full',
    countdown: true,
    lists: { tw: TW_LIST, us: US_LIST },
    shioaji: { python: 'python3', env: '~/.sinobon.env', interval: 10 },
    holdings: { tw: [], us: [] },
  }
}

/** resolves `"auto"` off the watchlist length; an explicit 1/2 always wins */
function effectiveColumns(cfg: Config, listLength: number): 1 | 2 {
  if (cfg.columns === 1 || cfg.columns === 2) return cfg.columns
  return listLength > PAGE_SIZE_1COL ? 2 : 1
}

function pageSize(columns: 1 | 2): number {
  return columns === 2 ? PAGE_SIZE_2COL : PAGE_SIZE_1COL
}

/** the markets one feed tick prices, given where the band is pointed right now */
function feedMarkets(cfg: Config, market: MarketId): MarketId[] {
  if (cfg.feed === 'off') return []
  if (cfg.feed === 'both') return ['tw', 'us']
  if (cfg.feed === 'auto') return [market]
  return [cfg.feed]
}

/** what one market costs per tick, before the chart view's own bar fetch is added */
function marketRequests(cfg: Config, market: MarketId): number {
  if (market === 'us') return Math.ceil((cfg.lists.us.length + US_INDICES.length) / SPARK_BATCH)
  // MIS answers the whole list plus both indices in one call, whatever the
  // list length - there is no sparkline column left to pay Yahoo for on top.
  if (cfg.twSource === 'mis') return 1
  return Math.ceil((cfg.lists.tw.length + 1) / SPARK_BATCH)
}

/**
 * How many requests one feed tick costs, at its worst. `auto` prices one
 * market at a time, so it costs the dearer of the two rather than the sum;
 * `both` really does pay for both.
 */
function requestsPerTick(cfg: Config): number {
  if (cfg.feed === 'off') return 0
  const tw = marketRequests(cfg, 'tw')
  const us = marketRequests(cfg, 'us')
  return cfg.feed === 'both' ? tw + us : cfg.feed === 'tw' ? tw : cfg.feed === 'us' ? us : Math.max(tw, us)
}

/**
 * `feedMs` is an interval, and an interval alone does not bound the request
 * rate: 15 s with a 20-symbol Yahoo-fed list is 240 requests an hour against a
 * ceiling around 360, and `both` doubles that. The floor here turns the
 * budget into an interval, so no config can get the host banned.
 */
function feedInterval(cfg: Config): number {
  const budgetFloor = Math.ceil((requestsPerTick(cfg) * 3_600_000) / REQUESTS_PER_HOUR)
  return Math.max(cfg.feedMs, FEED_MS_MIN, budgetFloor)
}

function parseConfig(text: string | undefined): Config {
  const cfg = defaultConfig()
  if (!text) return cfg
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return cfg
  }
  if (!root) return cfg
  const market = str(root.market, 'auto')
  if (market === 'tw' || market === 'us' || market === 'auto') cfg.market = market
  cfg.refreshMs = Math.max(1000, num(root.refreshMs, cfg.refreshMs))
  if (root.sort === 'list') cfg.sort = 'list'
  if (root.highlight === false) cfg.highlight = false
  if (root.columns === 1 || root.columns === 2 || root.columns === 'auto') cfg.columns = root.columns
  const feed = root.feed
  if (feed === 'off' || feed === false) cfg.feed = 'off'
  else if (feed === 'auto' || feed === 'us' || feed === 'tw' || feed === 'both') cfg.feed = feed
  if (root.twSource === 'mis' || root.twSource === 'yahoo' || root.twSource === 'shioaji') {
    cfg.twSource = root.twSource
  }
  const shioaji = asRecord(root.shioaji)
  if (shioaji) {
    cfg.shioaji = {
      python: str(shioaji.python, cfg.shioaji.python),
      env: str(shioaji.env, cfg.shioaji.env),
      interval: Math.max(0, num(shioaji.interval, cfg.shioaji.interval)),
    }
  }
  cfg.feedMs = Math.max(FEED_MS_MIN, num(root.feedMs, cfg.feedMs))
  // 0 turns auto-paging off and leaves the `p` button as the only way to page
  const pageMs = num(root.pageMs, cfg.pageMs)
  cfg.pageMs = pageMs <= 0 ? 0 : Math.max(PAGE_MS_MIN, pageMs)
  if (root.animation === 'off' || root.animation === false) cfg.animation = 'off'
  if (root.countdown === false) cfg.countdown = false
  cfg.lists = { tw: parseList(root.tw, TW_LIST), us: parseList(root.us, US_LIST) }
  cfg.twIndices = parseTwIndices(root.twIndices)
  const holdings = asRecord(root.holdings)
  cfg.holdings = {
    tw: parseHoldingsList(holdings?.tw),
    us: parseHoldingsList(holdings?.us),
  }
  return cfg
}

/**
 * The manual alternative to `.claude/stock-holdings.json`: a `holdings` block
 * in `stock-band.json`, `{ tw: [...], us: [...] }`. `code` and `qty` are the
 * only fields that matter for the P&L math; `name` falls back to the code and
 * a bad or missing `qty`/`cost` reads as 0 rather than dropping the row, so a
 * typo shows up as an obviously wrong number instead of a silently missing
 * holding.
 */
function parseHoldingsList(value: unknown): Holding[] {
  if (!Array.isArray(value)) return []
  const out: Holding[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (!entry) continue
    const code = str(entry.code, '')
    if (!code) continue
    out.push({
      code,
      name: str(entry.name, code),
      qty: num(entry.qty, 0),
      cost: num(entry.cost, 0),
      price: typeof entry.price === 'number' ? entry.price : undefined,
      prevClose: typeof entry.prevClose === 'number' ? entry.prevClose : undefined,
    })
  }
  return out
}

/**
 * The footer's Taiwan index rows. A channel the exchange does not know simply
 * answers nothing and `publish` leaves that row out, so a typo costs one
 * missing row rather than the whole footer. `name` has to be Latin: the board
 * flaps a row one character at a time and a Chinese character has no drum to
 * riffle through, so a Chinese name would sit there unable to turn.
 */
function parseTwIndices(value: unknown): TwIndex[] {
  if (!Array.isArray(value)) return TW_INDICES
  const out: TwIndex[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (!entry) continue
    const code = str(entry.code, '')
    if (!code) continue
    const known = TW_INDICES.find(i => i.code === code)
    out.push({
      code,
      name: str(entry.name, known?.name ?? code.toUpperCase()),
      ex: entry.ex === 'otc' ? 'otc' : 'tse',
    })
  }
  return out.length > 0 ? out : TW_INDICES
}

type QuotesFile = {
  asOf: number
  market?: MarketId
  /** where the snapshot came from, so the band can say so in its footer */
  origin?: 'file' | 'live'
  /** what the footer calls that source, e.g. `證交所 即時`; '' falls back to the origin */
  sourceLabel?: string
  /**
   * when the prices traded, not when this module read them. The band prints
   * this as 更新, so the clock on screen cannot claim a freshness the data
   * does not have.
   */
  dataAt?: number
  /** bumped once per snapshot; the board's live dot advances on it */
  seq?: number
  quotes: Record<string, FileQuote>
  index?: { value: number; change: number; pct: number }
  /** every index the feed carries, in display order; the board flips through them */
  indices?: IndexRow[]
  /**
   * the snapshot before this one, keyed the same way. The board turns a row
   * from its old number to its new one, and only the board knows how - it
   * needs somewhere to turn from.
   */
  prev?: Record<string, FileQuote>
  /** what the bars are, e.g. "5 分 K"; only the feed knows */
  barLabel?: string
}

// a bar is [open, high, low, close] or { o, h, l, c } - accept both, since
// which one a feed hands over is not worth a conversion step in the fetcher
function parseBars(value: unknown): Bar[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Bar[] = []
  for (const raw of value) {
    if (Array.isArray(raw)) {
      const four = raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (four.length >= 4) out.push([four[0], four[1], four[2], four[3]])
      continue
    }
    const obj = asRecord(raw)
    if (!obj) continue
    const o = num(obj.o ?? obj.open, NaN)
    const h = num(obj.h ?? obj.high, NaN)
    const l = num(obj.l ?? obj.low, NaN)
    const c = num(obj.c ?? obj.close, NaN)
    if ([o, h, l, c].every(Number.isFinite)) out.push([o, h, l, c])
  }
  return out.length > 0 ? out : undefined
}

// `.claude/stock-quotes.json` is the seam a real feed writes; see
// stock-band.example.json for the shape. Anything stale or malformed is
// ignored and the band falls back to demo prices.
function parseQuotes(text: string | undefined, now: number): QuotesFile | undefined {
  if (!text) return undefined
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
  if (!root) return undefined
  const asOf = num(root.asOf, 0)
  if (!asOf || now - asOf > QUOTE_STALE_MS) return undefined
  const quotesRaw = asRecord(root.quotes)
  if (!quotesRaw) return undefined
  const quotes: Record<string, FileQuote> = {}
  for (const [code, raw] of Object.entries(quotesRaw)) {
    const entry = asRecord(raw)
    if (!entry) continue
    const price = num(entry.price, NaN)
    if (!Number.isFinite(price)) continue
    quotes[code] = {
      price,
      prevClose: typeof entry.prevClose === 'number' ? entry.prevClose : undefined,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      bars: parseBars(entry.bars),
    }
  }
  const market = root.market === 'tw' || root.market === 'us' ? root.market : undefined
  const idx = asRecord(root.index)
  // a fetcher that carries more than one index (Taiwan has 加權 and 櫃買) can
  // hand the whole board over and the footer flips through it
  const indices: IndexRow[] = []
  for (const raw of Array.isArray(root.indices) ? (root.indices as unknown[]) : []) {
    const row = asRecord(raw)
    const name = str(row?.name, '')
    if (!row || !name) continue
    indices.push({ name, value: num(row.value, 0), change: num(row.change, 0), pct: num(row.pct, 0) })
  }
  return {
    asOf,
    market,
    origin: 'file',
    // a file that knows when its prices traded says so in dataAt; one that does
    // not falls back to when it was written
    dataAt: num(root.dataAt, asOf),
    seq: Math.floor(asOf / 1000),
    quotes,
    index: idx
      ? { value: num(idx.value, 0), change: num(idx.change, 0), pct: num(idx.pct, 0) }
      : undefined,
    ...(indices.length > 0 ? { indices } : {}),
    // `source` lets a fetcher name itself in the footer instead of 報價檔
    sourceLabel: typeof root.source === 'string' ? root.source : undefined,
    barLabel: typeof root.barLabel === 'string' ? root.barLabel : undefined,
  }
}

// --- holdings file (.claude/stock-holdings.json) ----------------------------
type HoldingsFile = {
  asOf: number
  market?: MarketId
  source?: string
  holdings: Holding[]
}

/**
 * `.claude/stock-holdings.json` - positions the 損益 view prices, written by
 * the Shioaji fetcher every tick (after `list_positions`) or by hand. Unlike
 * the quotes file this is never treated as stale: a position does not go
 * wrong just because nobody wrote a fresh copy in the last two minutes, so
 * QUOTE_STALE_MS does not apply here. `asOf` still travels through, so the
 * board can print when the snapshot was taken.
 */
function parseHoldingsFile(text: string | undefined): HoldingsFile | undefined {
  if (!text) return undefined
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
  if (!root) return undefined
  const holdingsRaw = root.holdings
  const holdings = parseHoldingsList(holdingsRaw)
  if (holdings.length === 0) return undefined
  const market = root.market === 'tw' || root.market === 'us' ? root.market : undefined
  return {
    asOf: num(root.asOf, 0),
    market,
    source: typeof root.source === 'string' ? root.source : undefined,
    holdings,
  }
}

/**
 * The holdings file wins over `stock-band.json`'s `holdings` block for
 * whichever market it names (or for both, if it leaves `market` out); a
 * market the file does not cover falls back to the config block. Returns the
 * raw (unpriced) holdings plus what the footer should call the source and
 * when the snapshot was taken - `pricedHoldings` below fills in the price.
 */
function holdingsFor(
  market: MarketId,
  file: HoldingsFile | undefined,
  cfg: Config,
): { holdings: Holding[]; source: string; asOf: number } {
  if (file && (!file.market || file.market === market)) {
    return { holdings: file.holdings, source: file.source ?? '庫存檔', asOf: file.asOf }
  }
  const manual = cfg.holdings[market]
  return { holdings: manual, source: manual.length > 0 ? '手動設定' : '', asOf: 0 }
}

/**
 * Every holding's price, live quote first: a symbol the feed or the quotes
 * file is already carrying (because it is on the watchlist, or because the
 * feed also fetched it for this reason - see feedUs/feedTw) prices the
 * holding at the same number the table would show. A holding the feed never
 * touched falls back to whatever the holdings file itself carried
 * (`price`/`prevClose`), and a holding with neither reads as its own cost so
 * the P&L math never divides by zero or shows NaN.
 */
/**
 * Holdings the feed also has to fetch a price for, because they are not on
 * the watchlist. The feed's symbol set for a market is the watchlist UNION
 * these - see feedUs/feedTw - so every holding has a live price in the
 * quotes file, and buildProps still draws only the watchlist in the table
 * (item 6/7 of the spec): a holding-only code is priced but never shown
 * there. `ex` is left out (Taiwan holdings default to 上市 the same way
 * parseList's own default does); a 上櫃-only holding needs its own
 * watchlist entry with `"ex": "otc"` to price through MIS correctly.
 */
function holdingExtras(market: MarketId, list: Ticker[], cfg: Config): Ticker[] {
  const { holdings } = holdingsFor(market, lastHoldingsFile, cfg)
  const have = new Set(list.map(t => t.code))
  return holdings
    .filter(h => !have.has(h.code))
    .map(h => ({ code: h.code, name: h.name, prevClose: h.prevClose ?? h.cost ?? 100, amp: 0.8, phase: 0, period: 57, drift: 0 }))
}

function pricedHoldings(
  holdings: Holding[],
  quotesFile: QuotesFile | undefined,
  cfg: Config,
  market: MarketId,
): PricedHolding[] {
  return holdings.map(h => {
    const live = quotesFile?.quotes[h.code]
    const price = live?.price ?? h.price ?? h.cost
    const prevClose = live?.prevClose ?? h.prevClose ?? price
    // `h.name` defaults to `h.code` when the holdings file or the config's
    // `holdings` block left it out (parseHoldingsList), so `h.name ===
    // h.code` is how "this holding has no real name" shows up here. In that
    // case: the config/built-in watchlist's own name for the same code
    // (even one bought outside the watchlist can still be a known symbol),
    // then whatever the quotes file says, then the code itself as the last
    // resort - never a bare code standing in for a name when something
    // better is one lookup away.
    const configName = cfg.lists[market].find(t => t.code === h.code)?.name
    const name = h.name !== h.code ? h.name : (configName ?? live?.name ?? h.code)
    return { code: h.code, name, qty: h.qty, cost: h.cost, price, prevClose }
  })
}

// --- live feed: Yahoo ------------------------------------------------------
// The spark endpoint answers a whole symbol list in one request, with the last
// price, the previous close and the day's 5-minute closes - everything the
// table needs. The chart endpoint answers open/high/low/close for one symbol,
// which only the trend view needs. Both are public and keyless; both refuse a
// request that does not look like a browser, so FEED_UA is not optional.

// Both the CDN in front of Yahoo and the host's own fetch answer a repeated
// URL from cache - measured: six ticks over 80 seconds returned a byte-identical
// body and a frozen price. `_` makes every tick a new URL, and the no-cache
// headers cover the near side.
const FEED_HEADERS = { 'User-Agent': FEED_UA, 'Cache-Control': 'no-cache', Pragma: 'no-cache' }

function sparkUrl(symbols: string[], now: number): string {
  const list = symbols.map(encodeURIComponent).join(',')
  return `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${list}&range=1d&interval=5m&_=${now}`
}

function chartUrl(symbol: string, now: number): string {
  const s = encodeURIComponent(symbol)
  return `https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=1d&interval=5m&includePrePost=false&_=${now}`
}

/**
 * the Yahoo symbol for a watchlist entry. US codes already are symbols;
 * Taiwan needs the exchange suffix, and a code that carries its own dot
 * (someone wrote `2330.TW` in the config) is left alone.
 */
function yahooSymbol(market: MarketId, t: { code: string; ex?: TwExchange }): string {
  if (market === 'us') return t.code
  return t.code.includes('.') ? t.code : `${t.code}.${t.ex === 'otc' ? 'TWO' : 'TW'}`
}

/** MIS names a symbol by exchange: `tse_2330.tw`, `otc_6488.tw`, `tse_t00.tw` */
function misChannel(t: { code: string; ex?: TwExchange }): string {
  return `${t.ex === 'otc' ? 'otc' : 'tse'}_${t.code}.tw`
}

function misUrl(channels: string[], now: number): string {
  return `${MIS_URL}?ex_ch=${encodeURIComponent(channels.join('|'))}&json=1&delay=0&_=${now}`
}

/** MIS hands every number back as a string, and an untraded symbol as '-' */
function misNum(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n : NaN
}

/**
 * one MIS answer, keyed by plain code (`2330`, `t00`). `z` is the last trade
 * and it reads `-` between trades - the last actual deal is then in `trade.z`,
 * and a symbol that has not traded at all today has neither, so it falls back
 * to the open and finally to yesterday's close rather than dropping the row.
 * `tradedAt` is the exchange's own clock, which is what the band shows as 更新.
 */
function parseMis(text: string): { quotes: Record<string, FileQuote>; tradedAt: number } {
  const out: Record<string, FileQuote> = {}
  let tradedAt = 0
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return { quotes: out, tradedAt }
  }
  // an error payload is a 200 with rtcode set and no msgArray
  if (str(root?.rtcode, '0000') !== '0000') return { quotes: out, tradedAt }
  const rows = Array.isArray(root?.msgArray) ? (root.msgArray as unknown[]) : []
  for (const raw of rows) {
    const entry = asRecord(raw)
    if (!entry) continue
    const code = str(entry.c, '')
    const trade = asRecord(entry.trade)
    const price = [misNum(entry.z), misNum(trade?.z), misNum(entry.o), misNum(entry.y)].find(v =>
      Number.isFinite(v),
    )
    const prevClose = misNum(entry.y)
    if (!code || price === undefined || !Number.isFinite(prevClose)) continue
    const name = str(entry.n, '')
    out[code] = { price, prevClose, ...(name ? { name } : {}) }
    // tlong is already in milliseconds
    const at = misNum(entry.tlong)
    if (Number.isFinite(at)) tradedAt = Math.max(tradedAt, at)
  }
  return { quotes: out, tradedAt }
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? asRecord(value[0]) : undefined
}

/**
 * the spark payload, keyed by Yahoo symbol; a symbol that came back broken is
 * dropped. `tradedAt` is the newest `regularMarketTime` in the answer - the
 * exchange's own clock, which is what the band shows as 更新.
 */
function parseSpark(text: string): { quotes: Record<string, FileQuote>; tradedAt: number } {
  const out: Record<string, FileQuote> = {}
  let tradedAt = 0
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return { quotes: out, tradedAt }
  }
  const spark = asRecord(root?.spark)
  const results = Array.isArray(spark?.result) ? (spark.result as unknown[]) : []
  for (const raw of results) {
    const entry = asRecord(raw)
    if (!entry) continue
    const symbol = str(entry.symbol, '')
    const response = firstRecord(entry.response)
    const meta = asRecord(response?.meta)
    if (!symbol || !meta) continue
    const price = num(meta.regularMarketPrice, NaN)
    const prevClose = num(meta.previousClose, num(meta.chartPreviousClose, NaN))
    if (!Number.isFinite(price) || !Number.isFinite(prevClose)) continue
    out[symbol] = { price, prevClose }
    // Yahoo answers seconds; the band works in milliseconds
    tradedAt = Math.max(tradedAt, num(meta.regularMarketTime, 0) * 1000)
  }
  return { quotes: out, tradedAt }
}

/** one symbol's 5-minute K bars; a bar with a null leg is dropped, not patched */
function parseChartBars(text: string): Bar[] | undefined {
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
  const chart = asRecord(root?.chart)
  const result = firstRecord(chart?.result)
  const quote = asRecord(firstRecord(asRecord(result?.indicators)?.quote))
  if (!quote) return undefined
  const o = quote.open
  const hi = quote.high
  const lo = quote.low
  const c = quote.close
  if (!Array.isArray(o) || !Array.isArray(hi) || !Array.isArray(lo) || !Array.isArray(c)) return undefined
  const bars: Bar[] = []
  for (let i = 0; i < c.length; i++) {
    const leg = [o[i], hi[i], lo[i], c[i]]
    if (leg.every(v => typeof v === 'number' && Number.isFinite(v))) {
      bars.push([leg[0] as number, leg[1] as number, leg[2] as number, leg[3] as number])
    }
  }
  return bars.length > 0 ? bars.slice(-CHART_BARS) : undefined
}

// --- board props -----------------------------------------------------------
type BoardProps = {
  market: MarketId
  marketLabel: string
  phase: Phase
  sessionNote: string
  /** the same hours in Taipei time, '' when the market already trades on it */
  taipeiNote: string
  clock: string
  quotes: QuoteRow[]
  index: { name: string; value: number; change: number; pct: number }
  /** what the footer flips through; one entry means it just sits there */
  indices: IndexRow[]
  source: 'demo' | 'file' | 'live'
  /** what the footer calls the source; '' lets the board name it from `source` */
  sourceLabel: string
  /** the plugin's own version, read from its manifest; '' when it could not be */
  version: string
  highlight: boolean
  sorted: boolean
  /** 1 = single-column table, 2 = two symbols a row; see effectiveColumns() */
  columns: 1 | 2
  view: View
  focus: number
  barLabel: string
  sessionOpen: string
  sessionClose: string
  /** snapshot counter; the board's live dot flips on it (0 while faking prices) */
  seq: number
  /**
   * bumped whenever the rows should turn - a new snapshot OR a page change.
   * Kept apart from `seq` because the live dot must mean "the feed answered",
   * and a page turn is not the feed answering.
   */
  turn: number
  /** which page of the watchlist is on the board, and how many there are */
  page: number
  pageCount: number
  /** when the next feed request is due, in epoch ms; 0 while nothing is fetching */
  nextFeedAt: number
  /** 'full' = flaps and blinks, 'off' = a still board */
  animation: 'full' | 'off'
  countdown: boolean
  now: number
  /** `view: "pnl"` only; already priced (pricedHoldings) - board.tsx only formats */
  holdings: PricedHolding[]
  holdingsSource: string
  holdingsAt: number
  holdingsPage: number
  holdingsPageCount: number
}

/** how long after a page change the outgoing rows are still worth turning from */
const PAGE_TURN_WINDOW_MS = 2500
/** holdings per page in the pnl view - rows 2..6 of its 8-row board */
const PNL_PAGE_SIZE = 5

function buildProps(
  now: number,
  cfg: Config,
  quotesFile: QuotesFile | undefined,
  mode: MarketMode,
  view: View,
  focus: number,
): BoardProps {
  const { market, phase } = pickMarket(now, mode)
  const conf = MARKETS[market]
  const list = cfg.lists[market]
  let usedFile = false

  const quotes = list.map(sym => {
    const fromFile = quotesFile?.quotes[sym.code]
    if (fromFile) {
      usedFile = true
      const prevClose = fromFile.prevClose ?? sym.prevClose
      return quoteRow(
        { ...sym, name: fromFile.name ?? sym.name },
        fromFile.price,
        prevClose,
        fromFile.bars,
        quotesFile?.prev?.[sym.code]?.price,
      )
    }
    if (quotesFile) {
      // The market HAS a live/override snapshot - it just never priced this
      // particular code (a fetcher whose own list is narrower than the
      // band's, or a gap the Yahoo bridge merge in quotesFor did not cover
      // either). A demo-walk number here would look like a real price under
      // a 永豐 即時/證交所 即時 footer, so this draws as a dim placeholder
      // instead (board.tsx reads QuoteRow.noData).
      return { ...quoteRow(sym, sym.prevClose, sym.prevClose), noData: true }
    }
    return quoteRow(sym, demoPrice(sym, now), sym.prevClose)
  })

  if (cfg.sort === 'change') quotes.sort((a, b) => b.pct - a.pct)

  // The single-column table shows 5 symbols a page, the two-column one 10 -
  // effectiveColumns() picks which off the watchlist length (or the config's
  // explicit override). Either way the table Client is always the same 8
  // terminal rows: one page is on the board and the rest wait their turn, the
  // way a departures board shows the next five flights rather than growing.
  const columns = effectiveColumns(cfg, list.length)
  const perPage = pageSize(columns)
  const pages = Math.max(1, Math.ceil(quotes.length / perPage))
  lastPageCount = pages
  const pageIdx = ((page % pages) + pages) % pages
  const shown = quotes.slice(pageIdx * perPage, pageIdx * perPage + perPage)

  // A page turn changes every row at once, so every row turns - including the
  // ones whose price did not move, and including the symbol and the name.
  // Price updates keep their own `was` (set in quoteRow), which carries no
  // code/name and so leaves the left-hand columns still.
  if (pageFrom && now - pageAt < PAGE_TURN_WINDOW_MS) {
    for (let i = 0; i < shown.length; i++) {
      const before = pageFrom[i]
      if (!before) continue
      shown[i] = {
        ...shown[i],
        was: {
          price: before.price,
          change: before.change,
          pct: before.pct,
          code: before.code,
          name: before.name,
        },
      }
    }
  }
  // what setPage turns away from next time; read only at the moment of a page
  // change, so rewriting it on every render costs nothing
  lastShown = shown

  // K bars are demo-only for the one symbol the chart view is showing: a
  // whole page of chart-length bars would be hundreds of numbers crossing
  // into the board every refresh for nothing.
  const focusIdx = Math.max(0, Math.min(shown.length - 1, focus))
  if (view === 'chart' && shown.length > 0) {
    const q = shown[focusIdx]
    if (!usedFile && (q.bars?.length ?? 0) < CHART_BARS) {
      const sym = list.find(t => t.code === q.code)
      if (sym) q.bars = demoBars(sym, now, CHART_BARS)
    }
  }

  const idxPct = quotesFile?.index
    ? quotesFile.index.pct
    : conf.indexDrift + conf.indexAmp * Math.sin((2 * Math.PI * (now / 1000)) / 89)
  const idxValue = quotesFile?.index ? quotesFile.index.value : conf.indexClose * (1 + idxPct / 100)
  const idxChange = quotesFile?.index ? quotesFile.index.change : idxValue - conf.indexClose

  // The pnl view's own list and paging - see the `holdingsPage` module state
  // comment for why it is not the watchlist's `page`.
  const { holdings: rawHoldings, source: holdingsSource, asOf: holdingsAt } = holdingsFor(
    market,
    lastHoldingsFile,
    cfg,
  )
  const priced = pricedHoldings(rawHoldings, quotesFile, cfg, market)
  const holdingsPages = Math.max(1, Math.ceil(priced.length / PNL_PAGE_SIZE))
  lastHoldingsPageCount = holdingsPages
  const holdingsPageIdx = ((holdingsPage % holdingsPages) + holdingsPages) % holdingsPages

  return {
    market,
    marketLabel: conf.label,
    phase,
    sessionNote: sessionNote(now, market, phase),
    taipeiNote: taipeiNote(now, market, phase),
    // open: the market-local time the prices on screen traded at - NOT the
    // redraw clock. The band redraws every few seconds but only fetches every
    // 30, so printing `now` here claimed a freshness the prices did not have.
    // closed: the session's close time, so "收盤 13:30" cannot read as "last
    // updated".
    clock:
      phase === 'open' ? localParts(quotesFile?.dataAt ?? now, conf.offset(now)).clock : hhmm(conf.close),
    // the live dot advances once per snapshot, so a frozen feed shows a frozen
    // dot instead of an animation that says "live" whatever happens
    seq: quotesFile?.seq ?? 0,
    turn: turnSeq,
    page: pageIdx,
    pageCount: pages,
    // the board counts this down on its own clock; 0 means nothing is fetching
    // and the board then shows no countdown rather than a stuck number
    nextFeedAt:
      cfg.feed === 'off' || !quotesFile || quotesFile.origin !== 'live' || !marketNeedsFeed(now, market)
        ? 0
        : nextFeedAt,
    animation: cfg.animation,
    countdown: cfg.countdown,
    quotes: shown,
    index: { name: conf.indexName, value: idxValue, change: idxChange, pct: idxPct },
    // Taiwan has one index and no feed, so it falls through to the single row
    // and the board's flip finds nothing to flip
    indices:
      quotesFile?.indices && quotesFile.indices.length > 0
        ? quotesFile.indices
        : [{ name: conf.indexName, value: idxValue, change: idxChange, pct: idxPct }],
    source: usedFile ? (quotesFile?.origin ?? 'file') : 'demo',
    sourceLabel: usedFile ? (quotesFile?.sourceLabel ?? '') : '',
    version,
    highlight: cfg.highlight,
    sorted: cfg.sort === 'change',
    columns,
    view,
    focus: focusIdx,
    barLabel: quotesFile?.barLabel ?? (usedFile ? 'K 棒' : 'K 棒（示範）'),
    sessionOpen: hhmm(conf.open),
    sessionClose: hhmm(conf.close),
    now,
    // The full priced list, not just the page on screen: board.tsx slices it
    // itself for the 5 rows it draws (holdingsPage says which slice), but it
    // also sums the footer's totals over the whole portfolio, which a
    // pre-sliced list could not answer.
    holdings: priced,
    holdingsSource,
    holdingsAt,
    holdingsPage: holdingsPageIdx,
    holdingsPageCount: holdingsPages,
  }
}

// --- module state (memory only: a fresh session starts unsnoozed) ----------
// The poll owns the slow, IO-backed half of the state (config + the quotes
// file); ui.render builds the props from it on every draw, so a button press
// changes the view on the same frame instead of waiting out a refresh tick.
let ready = false
let lastFile: QuotesFile | undefined // .claude/stock-quotes.json, while it is fresh
let lastHoldingsFile: HoldingsFile | undefined // .claude/stock-holdings.json; never expired, see parseHoldingsFile
// when spawnShioaji last ran, so it is never re-run more than once a minute
// (see spawnShioaji's own comment for the full respawn rule)
let lastShioajiSpawn = 0
// the feed's last good snapshot per market, with the one before it for the
// turn. Keyed by market because a snapshot must never reach the other board:
// US prices under 加權指數 would be worse than no prices at all.
let liveBy: Partial<Record<MarketId, { file: QuotesFile; prev?: Record<string, FileQuote> }>> = {}
// keyed `<market>:<code>`, since a Taiwan code and a US ticker share a namespace
let liveBars: Record<string, { bars: Bar[]; at: number }> = {}
let feedSkipUntil = 0 // set by a 429 or a network error, doubling each time
let feedFailures = 0
let feedSeq = 0 // one per snapshot the feed accepted; drives the board's live dot
let nextFeedAt = 0 // when the next request is due; the board counts down to it
let barsInFlight = false
// the render hook asks for the chart view's K bars; the feed owns the request
let requestBars: ((market: MarketId, code: string) => void) | undefined
// ...and asks for a whole tick when the market button lands on a market the
// feed has no snapshot for, so a switch does not sit on 示範資料 until the
// next scheduled tick comes round
let requestFeed: (() => void) | undefined
let feedInFlight = false
let config: Config = defaultConfig()
let modeOverride: MarketMode | undefined
let snoozedUntil = 0
// the chart view walks the list one symbol at a time and then returns to the
// table, so one button covers both "show me the chart" and "next symbol"
let view: View = 'table'
let focus = 0
// how many quotes the last drawn board held, so a posted row index can be
// checked against something real: a Client's post is code's word, not the
// engine's, and focus is read straight into props.quotes[focus].
let shownCount = 0
// The band draws from a COPY of this plugin under
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, frozen at install
// time - editing the working tree changes nothing until `claude plugin update`
// and a restart. So "which build am I looking at" is a real question, and the
// footer answers it: this is read from the manifest that shipped beside the
// code actually running, not from a constant that can drift from it.
let version = ''

// --- paging ----------------------------------------------------------------
// A watchlist longer than five symbols is shown one page at a time. The page
// index lives here rather than in the board because the button above the band
// has to show which page you are on, and only this module draws buttons.
let page = 0
let pageAt = 0 // when the current page arrived, so the turn has a start time
let lastShown: QuoteRow[] = [] // the page on the board right now
let pageFrom: QuoteRow[] | undefined // the page it turned away from
// bumped by a new snapshot AND by a page change: it is what tells the board to
// start a turn, which `seq` cannot do without making the live dot lie
let turnSeq = 0
// how many pages the board last drew. The page clock and the page button both
// need it and neither can work out the market's list on its own, so buildProps
// - which runs on every render - leaves it here.
let lastPageCount = 1

// The pnl view's own page, kept apart from the watchlist's `page` above: the
// two views can never be on screen together, but their page counts differ
// (5 holdings a page vs. 5 or 10 watchlist rows) and a shared counter would
// leave the pnl view on whatever page the watchlist happened to be on.
let holdingsPage = 0
let lastHoldingsPageCount = 1

function pageCount(): number {
  return lastPageCount
}

/**
 * Turn the page when the one on the board has had its `pageMs`, and not a tick
 * sooner. It rides the config poll rather than owning a timer of its own,
 * because a timer of its own cannot be reset: pressing 翻頁 at 9.9 s of a 10 s
 * interval used to leave the page you asked for on screen for 100 ms before
 * the interval fired and took it away. `pageAt` already records when the page
 * arrived and `setPage` already updates it, so a manual press pushes the
 * deadline out for free. The cost is granularity - the turn lands on the next
 * poll after the deadline, so up to `refreshMs` late, which at a 10 s page and
 * a 3 s poll is invisible next to the 100 ms flash it replaces.
 */
function autoPage(now: number) {
  if (config.pageMs <= 0) return
  // Nothing to page through, and the chart view owns the list already. Restart
  // the deadline rather than just returning, so the page gets its full hold
  // from the moment it is back on screen instead of turning the instant you
  // come back from the chart or from 收起.
  if (now < snoozedUntil || view !== 'table' || pageCount() < 2) {
    pageAt = now
    return
  }
  // first poll of the session: start the clock, do not turn off a zero
  if (pageAt === 0) {
    pageAt = now
    return
  }
  if (now - pageAt < config.pageMs) return
  setPage((page + 1) % pageCount(), now)
}

function setPage(next: number, now: number) {
  if (next === page) return
  pageFrom = lastShown
  pageAt = now
  page = next
  turnSeq += 1
}

/**
 * Whether a snapshot still describes the market. While it trades, two minutes
 * without a new price means the feed died and the band has to say so rather
 * than keep drawing a price nobody is quoting. Once the market closes the
 * price cannot change, so a snapshot taken after the close stays true until
 * the next session - expiring it on the same two-minute rule would throw away
 * a real closing price and draw the demo walk over it.
 */
function snapshotHolds(asOf: number, now: number, market: MarketId): boolean {
  if (phaseOf(now, market) === 'open') return now - asOf <= QUOTE_STALE_MS
  return asOf >= lastCloseAt(now, market)
}

/**
 * Whether this market is worth a request right now. A closed market answers
 * the same closing price every time, so the run costs nothing but the ban
 * risk: one fetch after the close captures it and the rest are waste. At 30 s
 * a tick and two requests a tick, a watchlist left open overnight used to
 * spend about 1,900 requests re-reading a number that had stopped moving.
 */
function marketNeedsFeed(now: number, market: MarketId): boolean {
  if (phaseOf(now, market) === 'open') return true
  const snap = liveBy[market]
  // never fetched, or the snapshot predates the close and so is not the
  // closing price yet
  return !snap || snap.file.asOf < lastCloseAt(now, market)
}

// The quotes file wins over the feed: it is the explicit override. A market
// with no snapshot falls back to the demo walk, which is what the footer's
// 示範資料 tag is for.
function quotesFor(market: MarketId, now: number): QuotesFile | undefined {
  if (lastFile && (!lastFile.market || lastFile.market === market)) {
    // The override file wins, but it does not have to be COMPLETE to win: a
    // fetcher whose own watchlist is narrower than the band's (or briefly
    // out of date) can leave a code the table draws with no quote at all.
    // `liveBy[market]` is the built-in feed's own last snapshot for this
    // market - for `twSource: "shioaji"` that is exactly the Yahoo bridge
    // spawnShioaji runs while the override is stale (feedTwYahoo), and its
    // codes are the band's full watchlist. Fill gaps from it before falling
    // through to buildProps' own noData marker; the override's own entries
    // always win over the bridge's.
    const bridge = liveBy[market]
    const bridgeHolds = bridge && snapshotHolds(bridge.file.asOf, now, market)
    if (!bridgeHolds) return lastFile
    return { ...lastFile, quotes: { ...bridge.file.quotes, ...lastFile.quotes } }
  }
  const snap = liveBy[market]
  if (!snap || !snapshotHolds(snap.file.asOf, now, market)) return undefined
  const quotes: Record<string, FileQuote> = {}
  for (const [code, quote] of Object.entries(snap.file.quotes)) {
    const bars = liveBars[`${market}:${code}`]
    quotes[code] = bars && now - bars.at <= BARS_STALE_MS ? { ...quote, bars: bars.bars } : quote
  }
  return { ...snap.file, quotes, ...(snap.prev ? { prev: snap.prev } : {}) }
}

// The market button is the title itself, and its label is just the market ON
// THE BAND (pickMarket's result) - 台股 ▾ / 美股 ▾, nothing else. It used to
// append 固定 to distinguish a pinned market from the same market in auto
// mode, which is a distinction the label has no business carrying: the two
// draw identical boards and only differ hours later, at the handover.
function marketButtonLabel(marketLabel: string): string {
  return `${marketLabel} ▾`
}

/**
 * Two labels, so two states the button can land on. `auto` stays the state a
 * session starts in - it tracks the clock until someone presses - but it is
 * not a stop on the cycle, because pressing into it would redraw the same
 * board and read as a dead button. From auto the press means "show me the
 * OTHER market", and after that it toggles.
 */
function nextMode(mode: MarketMode, onBand: MarketId): MarketMode {
  if (mode === 'auto') return onBand === 'tw' ? 'us' : 'tw'
  return mode === 'tw' ? 'us' : 'tw'
}

// --- the title/button row ----------------------------------------------
// This module draws the row directly with Box/Text/Button (docs/api-notes.md:
// a Client surface has no Button), so it needs its own copies of the colors
// and the display-width math board.tsx uses for the same session badge - the
// two files never import each other (a Client module loads by literal path
// only; see docs/api-notes.md).
const ORANGE = '#d97757'
const MOON_BLUE = '#8ab4f8' // the closed-session moon, so 休市 still reads at a glance
const DIM = '#6e7681'
const SUN = '☀'
const MOON = '☽'

// the table Client lost its title row (the button row above it draws that
// now); the chart Client kept its own, since that title names the symbol
// being charted rather than the market
const TABLE_BOARD_ROWS = 8
const CHART_BOARD_ROWS = 8
const PNL_BOARD_ROWS = 8

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  return wide ? 2 : 1
}
function dispWidth(s: string): number {
  let w = 0
  for (const ch of Array.from(s)) w += charWidth(ch)
  return w
}

// rough width of the right-hand button group (翻頁 X/Y, 趨勢圖, 收起 30分, plus
// the gaps a Button draws around its own label) - there is no way to measure
// what the framework actually renders from inside the hook, so the left group
// treats this as a fixed reservation when it decides whether 台灣 HH:MM-HH:MM
// still fits next to the session text.
const RIGHT_BUTTON_GROUP_COLS = 40

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)

    try {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
      if (typeof manifest?.version === 'string') version = `v${manifest.version}`
    } catch {
      // a band that cannot name its version still draws prices
    }

    // Both files are optional and most sessions have neither, but the host logs
    // every failed $.fs.read at ERROR level - so polling them every few seconds
    // fills a new user's debug log with two errors per tick about files they
    // were never required to create. A missing file is retried every MISS_EVERY
    // ticks instead; the counter resets the moment it turns up, so a session
    // that does have a config reads it on every poll as before.
    const MISS_EVERY = 10
    const misses: Record<string, number> = {}
    const readOptional = async (path: string): Promise<string | undefined> => {
      const missed = misses[path] ?? 0
      if (missed > 0 && missed % MISS_EVERY !== 0) {
        misses[path] = missed + 1
        return undefined
      }
      try {
        const text = await $.fs.read(path)
        misses[path] = 0
        return text
      } catch {
        misses[path] = missed + 1
        return undefined
      }
    }

    const poll = async () => {
      const now = await $.clock.now()
      const configText = await readOptional(CONFIG_PATH)
      const quotesText = await readOptional(QUOTES_PATH)
      const holdingsText = await readOptional(HOLDINGS_PATH)

      config = parseConfig(configText)
      lastFile = parseQuotes(quotesText, now)
      lastHoldingsFile = parseHoldingsFile(holdingsText)
      ready = true
      autoPage(now)
      // redraw while snoozed too, so the collapsed row's countdown ticks down
      $.ui.invalidate('ui.render')
    }

    // once immediately so the band is there on the first prompt, then on the
    // refresh interval the config asked for. The interval is fixed for the
    // session: changing refreshMs later needs /reload-plugins.
    await poll().catch(err => $.ui.log(`tw-stock-mod: poll failed: ${err}`))
    $.clock.every(config.refreshMs, () => {
      poll().catch(err => $.ui.log(`tw-stock-mod: poll failed: ${err}`))
    })

    // A failed request must never become a made-up price: the feed keeps the
    // last good snapshot, the snapshot goes stale after QUOTE_STALE_MS, and the
    // band then falls back to the demo walk with the footer saying so.
    const backOff = (now: number, why: string) => {
      feedFailures += 1
      const wait = Math.min(config.feedMs * 2 ** feedFailures, FEED_BACKOFF_MAX_MS)
      feedSkipUntil = now + wait
      $.ui.log(`tw-stock-mod: feed ${why}, next try in ${Math.round(wait / 1000)}s`)
    }

    /**
     * Hand one market's parsed snapshot to the board. Everything above this
     * differs per market - the endpoint, the symbol spelling, the index list -
     * and everything below it is the same, so it lives here once.
     */
    const publish = (opts: {
      market: MarketId
      list: Ticker[]
      /** parsed rows, keyed the way the endpoint spells a symbol */
      parsed: Record<string, FileQuote>
      /** how to spell a watchlist entry in that same keying */
      keyOf: (t: Ticker) => string
      indices: { key: string; name: string }[]
      /** which of those indices the market is read by */
      indexKey: string
      tradedAt: number
      now: number
      sourceLabel: string
      barLabel: string
    }): void => {
      const quotes: Record<string, FileQuote> = {}
      for (const sym of opts.list) {
        const q = opts.parsed[opts.keyOf(sym)]
        if (q) quotes[sym.code] = q
      }
      if (Object.keys(quotes).length === 0) {
        $.ui.log(`tw-stock-mod: ${opts.market} feed answered nothing usable; keeping the last snapshot`)
        return
      }
      // an index the answer skipped is left out rather than drawn at zero
      const indices: IndexRow[] = []
      for (const spec of opts.indices) {
        const row = opts.parsed[spec.key]
        if (!row) continue
        const prev = row.prevClose ?? row.price
        indices.push({
          name: spec.name,
          value: row.price,
          change: round2(row.price - prev),
          pct: prev ? ((row.price - prev) / prev) * 100 : 0,
        })
      }

      const idx = opts.parsed[opts.indexKey]
      const idxPrev = idx?.prevClose ?? idx?.price ?? 0
      feedSeq += 1
      turnSeq += 1
      nextFeedAt = opts.now + feedInterval(config)
      liveBy[opts.market] = {
        prev: liveBy[opts.market]?.file.quotes,
        file: {
          asOf: opts.now,
          market: opts.market,
          origin: 'live',
          sourceLabel: opts.sourceLabel,
          // the exchange's clock when it answered; only this module's own read
          // time is left if the answer carried none
          dataAt: opts.tradedAt || opts.now,
          seq: feedSeq,
          quotes,
          barLabel: opts.barLabel,
          ...(indices.length > 0 ? { indices } : {}),
          index: idx
            ? {
                value: idx.price,
                change: round2(idx.price - idxPrev),
                pct: idxPrev ? ((idx.price - idxPrev) / idxPrev) * 100 : 0,
              }
            : undefined,
        },
      }
      $.ui.invalidate('ui.render')
    }

    /**
     * One batched spark request where the symbols fit in one, two where they
     * do not: Yahoo answers `Number of symbols needs to be less than or equal
     * to 20`, so a full 20-symbol watchlist plus the three indices is 23 and
     * has to be split. feedInterval() has already widened the tick to pay for
     * the extra call. Returns undefined when a request failed, which is not
     * the same as an answer with nothing in it.
     */
    const fetchSpark = async (
      symbols: string[],
      now: number,
      what: string,
    ): Promise<{ quotes: Record<string, FileQuote>; tradedAt: number } | undefined> => {
      const quotes: Record<string, FileQuote> = {}
      let tradedAt = 0
      for (let i = 0; i < symbols.length; i += SPARK_BATCH) {
        const batch = symbols.slice(i, i + SPARK_BATCH)
        const res = await $.http.fetch(sparkUrl(batch, now + i), { headers: FEED_HEADERS })
        if (!res.ok) {
          backOff(now, `HTTP ${res.status}${what}`)
          return undefined
        }
        const part = parseSpark(res.text)
        Object.assign(quotes, part.quotes)
        tradedAt = Math.max(tradedAt, part.tradedAt)
      }
      return { quotes, tradedAt }
    }

    const feedUs = async (now: number) => {
      const list = [...config.lists.us, ...holdingExtras('us', config.lists.us, config)]
      const symbols = [...list.map(t => t.code), ...US_INDICES.map(i => i.symbol)]
      const answer = await fetchSpark(symbols, now, '')
      if (!answer) return
      feedFailures = 0
      publish({
        market: 'us',
        list,
        parsed: answer.quotes,
        keyOf: t => t.code,
        indices: US_INDICES.map(i => ({ key: i.symbol, name: i.name })),
        indexKey: US_INDEX_SYMBOL,
        tradedAt: answer.tradedAt,
        now,
        sourceLabel: 'Yahoo 即時',
        barLabel: '5 分 K',
      })
    }

    /**
     * Taiwan through the exchange's own intraday endpoint, which answers the
     * whole watchlist and both indices in one request. MIS carries no K
     * bars, so the chart view still goes to Yahoo per symbol the way the US
     * one does, whichever twSource prices the table.
     */
    // Taiwan via Yahoo - its own function because `twSource: "shioaji"`'s
    // spawn failure path (spawnShioaji) falls back to exactly this, not to
    // feedTw as a whole (which would otherwise re-read config.twSource and,
    // being 'shioaji', fall through to the MIS branch below instead).
    const feedTwYahoo = async (now: number) => {
      const list = [...config.lists.tw, ...holdingExtras('tw', config.lists.tw, config)]
      if (list.length === 0) return
      const symbols = [...list.map(t => yahooSymbol('tw', t)), TW_YAHOO_INDEX]
      const answer = await fetchSpark(symbols, now, ' (台股)')
      if (!answer) return
      feedFailures = 0
      publish({
        market: 'tw',
        list,
        parsed: answer.quotes,
        keyOf: t => yahooSymbol('tw', t),
        indices: [{ key: TW_YAHOO_INDEX, name: 'TAIEX' }],
        indexKey: TW_YAHOO_INDEX,
        tradedAt: answer.tradedAt,
        now,
        // Yahoo's Taiwan quotes are about twenty minutes behind, and the
        // footer has to say so rather than claim 即時
        sourceLabel: 'Yahoo 延遲',
        barLabel: '5 分 K',
      })
    }

    const feedTw = async (now: number) => {
      const list = [...config.lists.tw, ...holdingExtras('tw', config.lists.tw, config)]
      if (list.length === 0) return

      if (config.twSource === 'yahoo') return feedTwYahoo(now)

      // the first entry is the one the market is read by, so an empty list
      // would leave the board with no headline index at all - parseTwIndices
      // never returns one
      const indices = config.twIndices
      const channels = [...list.map(misChannel), ...indices.map(misChannel)]
      const res = await $.http.fetch(misUrl(channels, now), { headers: FEED_HEADERS })
      if (!res.ok) return backOff(now, `HTTP ${res.status} (證交所)`)
      const { quotes: parsed, tradedAt } = parseMis(res.text)
      if (Object.keys(parsed).length === 0) return backOff(now, '證交所 answered nothing usable')
      feedFailures = 0
      publish({
        market: 'tw',
        list,
        parsed,
        keyOf: t => t.code,
        indices: indices.map(i => ({ key: i.code, name: i.name })),
        indexKey: indices[0].code,
        tradedAt,
        now,
        sourceLabel: '證交所 即時',
        barLabel: '5 分 K',
      })
    }

    const feed = async () => {
      const now = await $.clock.now()
      // Snoozed means the table is not on screen at all, so the 30 minutes it
      // covers need no prices; a 429 sets feedSkipUntil; feedInFlight keeps a
      // slow answer from stacking a second request on top of it.
      if (config.feed === 'off' || now < snoozedUntil || now < feedSkipUntil || feedInFlight) return
      feedInFlight = true
      try {
        await feedOnce(now)
      } finally {
        feedInFlight = false
      }
    }

    const feedOnce = async (now: number) => {
      const onScreen = pickMarket(now, modeOverride ?? config.market).market
      for (const market of feedMarkets(config, onScreen)) {
        if (!marketNeedsFeed(now, market)) continue
        if (market === 'us') await feedUs(now)
        // twSource: "shioaji" hands Taiwan to the spawned script instead of
        // calling an HTTP endpoint itself - the script writes the quotes file
        // this module already reads as an override (QUOTES_PATH). While the
        // file is fresh, spawnShioaji does nothing beyond the heartbeat; while
        // it is stale (script not logged in yet, or dead) spawnShioaji ALSO
        // prices Taiwan through Yahoo for this tick, since the spawn's own
        // exit code cannot tell this module the backgrounded script failed.
        else if (config.twSource === 'shioaji') await spawnShioaji(now)
        else await feedTw(now)
      }
    }

    /**
     * `twSource: "shioaji"` route: spawn (or re-check) the fetcher script
     * rather than call an HTTP endpoint. See the ShioajiConfig doc comment
     * for why this cannot run inside the hooks module directly, and Config's
     * `twSource` doc for what the script's quotes file replaces.
     *
     * Respawn rule: once at session start (the first feed tick), then only
     * when the quotes file has gone stale (>120s, i.e. no script is feeding
     * it) AND the last spawn attempt was more than 60s ago - so a script
     * that is merely slow to log in is never spawned a second time on top of
     * itself, and a script that died is retried at most once a minute.
     */
    const spawnShioaji = async (now: number) => {
      const project = await $.session.cwd()
      const heartbeatPath = `${project}/.claude/stock-band.heartbeat`
      // Written every tick the Shioaji route is wanted, whether or not this
      // call ends up spawning - it is the signal the script watches: it
      // exits by itself once the heartbeat is older than 90s (band closed,
      // or moved to the US board), so a session that stops asking for
      // Taiwan prices does not leave the script running forever.
      try {
        await $.fs.write(heartbeatPath, String(now))
      } catch (err) {
        $.ui.log(`tw-stock-mod: could not write the shioaji heartbeat: ${err}`)
      }
      const stale = !lastFile || now - lastFile.asOf > QUOTE_STALE_MS
      if (!stale) return

      // Respawn is cooldown-gated (once a minute at most); the Yahoo
      // fallback below is NOT - see the comment past the spawn for why it
      // has to run on every stale tick regardless of whether this tick
      // attempted a spawn.
      if (!lastShioajiSpawn || now - lastShioajiSpawn >= 60_000) {
        lastShioajiSpawn = now
        const home = await $.env.get('HOME')
        const expand = (p: string) => (home && p.startsWith('~') ? home + p.slice(1) : p)
        const python = expand(config.shioaji.python)
        const env = expand(config.shioaji.env)
        const script = `${$.plugin.root}/scripts/fetch-quotes-shioaji.py`
        const logPath = `${project}/.claude/stock-shioaji.log`
        const pidPath = `${project}/.claude/stock-shioaji.pid`
        try {
          // `nohup ... >>log 2>&1 &`, wrapped in `/bin/sh -c`, is what lets
          // $.process.run resolve at all: run() is one-shot and waits for
          // the child's stdout/stderr pipes to close as well as its exit,
          // and a long-lived daemon's pipes never close on their own.
          // Redirecting them to the log file gives the wrapper's OWN
          // short-lived pipes something to close immediately - `&`
          // backgrounds the real script before that happens, so run() sees
          // the wrapper exit at once while the script keeps going past it,
          // logging to logPath instead of to a pipe nothing is reading.
          //
          // This also means the wrapper resolves with exitCode 0 whether or
          // not the BACKGROUNDED script itself goes on to fail (missing
          // python, missing env file, a bad login) - that failure happens
          // after `sh -c` has already returned, so this try/catch can only
          // ever catch a failure to launch the shell itself, never a
          // failure inside the detached job. The only signal this module
          // can observe for "the script isn't feeding the file" is the file
          // staying stale, which is exactly what the Yahoo fallback below
          // reacts to - it does not depend on this try/catch firing.
          // --codes is the band's own effective Taiwan watchlist (built-in
          // list included, not just whatever `stock-band.json` overrides) -
          // without it the script fell back to reading `tw` out of
          // stock-band.json itself, which is empty whenever a project has no
          // config file at all, and it then snapshotted only the account's
          // positions: every OTHER watchlist row stayed on a demo price
          // while the footer still said 永豐 即時. Passing the codes here is
          // what makes the script price the same list the table draws.
          const codes = config.lists.tw.map(t => t.code).join(',')
          await $.process.run(
            [
              '/bin/sh',
              '-c',
              `nohup "$0" "$@" >>"${logPath}" 2>&1 &`,
              python,
              script,
              '--project',
              project,
              '--env',
              env,
              '--interval',
              String(config.shioaji.interval),
              '--codes',
              codes,
              '--heartbeat',
              heartbeatPath,
              '--pidfile',
              pidPath,
            ],
            { cwd: project, timeoutMs: 15000 },
          )
        } catch (err) {
          // The shell itself failed to launch (e.g. no /bin/sh) - logged,
          // but not fatal: the Yahoo fallback below covers this tick too.
          $.ui.log(`tw-stock-mod: shioaji spawn failed (${err})`)
        }
      }

      // A missing python, a missing env file, or a dead login all show up
      // the same way from here: the quotes file stays stale. Rather than
      // wait out QUOTE_STALE_MS and fall all the way back to demo prices,
      // every stale tick also prices Taiwan through Yahoo - a fresh quotes
      // file, once the script does log in, wins over this on the very next
      // poll (quotesFor prefers `lastFile` unconditionally), so this is a
      // bridge, not a competing source.
      await feedTwYahoo(now)
    }

    // K bars cost one request per symbol, so only the symbol the trend view is
    // showing asks for them, and only once a minute.
    // K bars come from Yahoo for both markets: MIS has no candles at all, and
    // a 5-minute bar twenty minutes old still draws the right shape.
    const feedBars = async (market: MarketId, code: string) => {
      const now = await $.clock.now()
      if (config.feed === 'off' || now < feedSkipUntil || barsInFlight) return
      const key = `${market}:${code}`
      const have = liveBars[key]
      if (have && now - have.at < BARS_MAX_AGE_MS) return
      const sym = config.lists[market].find(t => t.code === code)
      if (!sym) return
      barsInFlight = true
      try {
        const res = await $.http.fetch(chartUrl(yahooSymbol(market, sym), now), { headers: FEED_HEADERS })
        if (!res.ok) return backOff(now, `HTTP ${res.status} (${code} K 棒)`)
        const bars = parseChartBars(res.text)
        if (!bars) return
        liveBars[key] = { bars, at: now }
        $.ui.invalidate('ui.render')
      } finally {
        barsInFlight = false
      }
    }

    requestBars = (market, code) => {
      feedBars(market, code).catch(err => $.ui.log(`tw-stock-mod: K 棒 failed: ${err}`))
    }

    requestFeed = () => {
      feed().catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
    }

    if (config.feed !== 'off') {
      const every = feedInterval(config)
      if (every > config.feedMs) {
        $.ui.log(
          `tw-stock-mod: ${requestsPerTick(config)} requests per tick, so the feed ticks every ` +
            `${Math.round(every / 1000)}s instead of ${Math.round(config.feedMs / 1000)}s ` +
            `(budget ${REQUESTS_PER_HOUR}/hour)`,
        )
      }
      await feed().catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
      $.clock.every(every, () => {
        feed().catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
      })
    }

    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const now = await $.clock.now()
    if (!ready) return next(e)

    const { Box, Button, Client, Text } = await $.ui.resolve(e)

    // Snoozing used to drop the band with no way back: the only exits were
    // waiting out the 30 minutes or restarting the session. Leave one row
    // behind that says how long is left and brings the table back.
    if (now < snoozedUntil) {
      const mins = Math.max(1, Math.ceil((snoozedUntil - now) / 60_000))
      const onWake = () => {
        snoozedUntil = 0
        $.ui.invalidate('ui.render')
      }
      // No hotkey (see the comment above the button row below for why) - this
      // one presses by click or by focus+Enter.
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="stock-band:wake" label={`股票列 ${mins}分 展開`} onPress={onWake} />
          </Box>
          {await next(e)}
        </Box>
      )
    }

    const cols = e.viewport?.columns ?? e.props.bodyColumns ?? 80
    const mode = modeOverride ?? config.market
    const props = buildProps(now, config, quotesFor(pickMarket(now, mode).market, now), mode, view, focus)

    // the trend view is the only thing that needs K bars, so it is the only
    // thing that asks for them; feedBars drops a request it already answered
    if (view === 'chart' && props.source === 'live' && props.quotes[props.focus]) {
      requestBars?.(props.market, props.quotes[props.focus].code)
    }

    // Button only draws from this module's own AbovePrompt tree - a Client
    // surface has no Button (docs/api-notes.md) - so the controls sit on their
    // own row directly above the table.
    const onSwitch = () => {
      modeOverride = nextMode(mode, props.market)
      // the market the button just landed on may never have been fetched: ask
      // for it now rather than showing demo prices until the next tick
      if (!quotesFor(pickMarket(now, modeOverride).market, now)) requestFeed?.()
      $.ui.invalidate('ui.render')
    }
    const onSnooze = () => {
      snoozedUntil = now + SNOOZE_MS
      $.ui.invalidate('ui.render')
    }
    const rowCount = props.quotes.length
    shownCount = rowCount
    const onPage = () => {
      setPage((props.page + 1) % props.pageCount, now)
      $.ui.invalidate('ui.render')
    }
    // One button used to do all three jobs - enter the chart, step to the next
    // symbol, and fall back to the table on the last one - which left no way
    // back to the symbol you just passed and no way out except walking to the
    // end. The chart view now gets its own three buttons, and 趨勢圖 only ever
    // opens the view.
    const onTrend = () => {
      view = 'chart'
      focus = 0
      $.ui.invalidate('ui.render')
    }
    const step = (by: number) => () => {
      const n = Math.max(1, rowCount)
      focus = (focus + by + n) % n
      $.ui.invalidate('ui.render')
    }
    const onPrev = step(-1)
    const onNext = step(1)
    const onList = () => {
      view = 'table'
      focus = 0
      $.ui.invalidate('ui.render')
    }
    // 損益 opens the pnl view the same way 趨勢圖 opens the chart one - its own
    // button, its own paging state (holdingsPage, not the watchlist's page).
    const onPnl = () => {
      view = 'pnl'
      $.ui.invalidate('ui.render')
    }
    const onHoldingsPage = () => {
      holdingsPage = (props.holdingsPage + 1) % props.holdingsPageCount
      $.ui.invalidate('ui.render')
    }

    // The market button carries the market name ON THE BAND and nothing else:
    // 台股 ▾ / 美股 ▾. It tracks the clock until the first press, then toggles.
    const open = props.phase === 'open'
    // Three views, three names, so every line in the button row below can
    // read forwards: `table ? 元素 : null`, `chart ? 元素 : null`, `pnl ?
    // 元素 : null`, never a negation that says what does NOT draw and has to
    // be reversed in the head before it says anything.
    const chart = props.view === 'chart'
    const pnl = props.view === 'pnl'
    const table = props.view === 'table'
    const marketLabel = marketButtonLabel(props.marketLabel)
    // 09:30-16:00 ET answers the wrong question in Taipei, so taipeiNote
    // restates it in local time - but only if it still fits: there is no way
    // to measure what the framework actually renders from inside the hook, so
    // this reserves a fixed budget for the button group on the right (see
    // RIGHT_BUTTON_GROUP_COLS) and drops the restatement first when it does not.
    const leftCoreWidth =
      dispWidth(marketLabel) + 1 + dispWidth(`${open ? SUN : MOON} ${open ? '盤中' : '休市'}`) + 1 +
      dispWidth(props.sessionNote)
    const showTaipei =
      table &&
      props.taipeiNote !== '' &&
      leftCoreWidth + 1 + dispWidth(props.taipeiNote) + RIGHT_BUTTON_GROUP_COLS <= cols

    // No hotkeys on any of these (2026-09-16, at the user's request: 先不加
    // 上快捷鍵). A letter hotkey only fires once one of the band's Buttons
    // already holds the focus ring (d.ts:653-658) - it buys nothing over
    // pressing Enter once the ring is there - and a digit hotkey fires from
    // an empty composer, which would eat a prompt that happens to start with
    // that digit. Every button below stays pressable by click or by
    // focus+Enter.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Button key="stock-band:market" label={marketLabel} onPress={onSwitch} />
            {/* The chart view's controls sit here, next to the symbol they move
                through, rather than stranded on the far right where the eye is
                not. The session state and hours give up the space because the
                chart draws its own title row with both already on it. */}
            {chart ? <Button key="stock-band:prev" label="◀ 上一檔" onPress={onPrev} /> : null}
            {chart ? (
              <Button key="stock-band:next" label={`下一檔 ▶ ${focus + 1}/${rowCount}`} onPress={onNext} />
            ) : null}
            {chart || pnl ? <Button key="stock-band:list" label="回清單" onPress={onList} /> : null}
            {table ? <Text> </Text> : null}
            {table ? (
              <Text color={open ? ORANGE : MOON_BLUE}>{`${open ? SUN : MOON} ${open ? '盤中' : '休市'}`}</Text>
            ) : null}
            {table ? <Text> </Text> : null}
            {table ? <Text color={DIM}>{props.sessionNote}</Text> : null}
            {showTaipei ? <Text> </Text> : null}
            {showTaipei ? <Text color={DIM}>{props.taipeiNote}</Text> : null}
          </Box>
          <Box flexDirection="row">
            {table && props.pageCount > 1 ? (
              <Button
                key="stock-band:page"
                label={`翻頁 ${props.page + 1}/${props.pageCount}`}
                onPress={onPage}
              />
            ) : null}
            {pnl && props.holdingsPageCount > 1 ? (
              <Button
                key="stock-band:pnl-page"
                label={`翻頁 ${props.holdingsPage + 1}/${props.holdingsPageCount}`}
                onPress={onHoldingsPage}
              />
            ) : null}
            {table ? <Button key="stock-band:trend" label="趨勢圖" onPress={onTrend} /> : null}
            {table ? <Button key="stock-band:pnl" label="損益" onPress={onPnl} /> : null}
            <Button key="stock-band:snooze" label="收起 30分" onPress={onSnooze} />
          </Box>
        </Box>
        <Client
          key="stock-band:table"
          module="./board.tsx"
          width={cols}
          height={props.view === 'chart' ? CHART_BOARD_ROWS : props.view === 'pnl' ? PNL_BOARD_ROWS : TABLE_BOARD_ROWS}
          props={{ ...props }}
        />
        {await next(e)}
      </Box>
    )
  })

  // Clicking a quote in the table opens its trend chart. The board hit-tests
  // the pointer (a Client has no Button) and posts the row it landed on; this
  // is the other end of that. It is a shortcut, not a replacement: the table
  // is not on screen in chart view, so 上一檔 / 下一檔 / 回清單 stay the only
  // way to move once the chart is up.
  //
  // `data` came from code, so it is input to validate, not a fact - hence the
  // bounds check against the board that was actually drawn.
  on('ui.message', async ($, e, next) => {
    // `e.module` is the path under the plugin folder (`hooks/board.tsx`), NOT
    // the `./board.tsx` literal the Client prop carries. Comparing it against
    // the prop threw every message away in silence: the pointer fired, the hit
    // test matched, the post went out, and this hook dropped it.
    if (e.element !== 'stock-band:table' || !e.module.endsWith('board.tsx')) return next(e)
    const pick = (e.data as { pick?: unknown } | null)?.pick
    if (typeof pick !== 'number' || !Number.isInteger(pick) || pick < 0 || pick >= shownCount) {
      return next(e)
    }
    view = 'chart'
    focus = pick
    $.ui.invalidate('ui.render')
    return {}
  })
}
