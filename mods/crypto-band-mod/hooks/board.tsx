/* @jsx h */
import type { ClientElements, ClientSurface, RenderNode } from 'claude-code'

type TextTag = ClientElements['Text']

// crypto-band's board: pure drawing, on its own frame clock (surface.every),
// independent of hooks/register.tsx. Quotes and paging/sort state arrive as
// props - this file never fetches anything and never decides what a price
// is, it only lays the table out.
//
// This is tw-stock-mod's board.tsx with everything that assumed a
// multi-market, session-based table (TW/US switching, open/closed hours,
// the K-bar chart view, the 損益 holdings view, the Solari index footer)
// removed. What is kept, per the crypto-band-mod brief: the table, two-
// column layout, paging, sort, and the split-flap row-turn animation and
// color scheme.
//
// Never name a local variable `h`: every JSX tag in this file compiles to h(...).

export type SortKey = 'change24h' | 'change1h' | 'volume' | 'list'

export type QuoteRow = {
  id: string
  symbol: string
  price: number
  pct1h: number
  pct24h: number
  volume24h: number
  /** what this row said before the last update; absent when nothing moved.
   * `id`/`symbol` are only set when the whole row changed coin (a page turn
   * or a rank cross), which is what makes the board flap the symbol too. */
  was?: { price: number; pct1h: number; pct24h: number; volume24h: number; id?: string; symbol?: string }
}

export type BoardProps = {
  quotes: QuoteRow[]
  /** 1 = single-column table (幣種/價格/1h%/24h%/24h量); 2 = two coins a row (幣種/價格/24h% only) */
  columns: 1 | 2
  sortKey: SortKey
  /** whether the active sort key gets an arrow on its header cell */
  sorted: boolean
  highlight: boolean
  page: number
  pageCount: number
  /** bumped on a new snapshot or a page/sort change; what starts a row turn */
  turn: number
  /** bumped once per successful fetch; the live dot flips on it */
  seq: number
  /** true once the most recent fetch attempt failed - the last GOOD quotes stay on screen, this just flags them */
  stale: boolean
  /** epoch ms of the last successful fetch; 0 = never fetched yet */
  lastUpdateAt: number
  /** epoch ms of the next feed request; 0 while nothing is scheduled */
  nextFeedAt: number
  animation: 'full' | 'off'
  countdown: boolean
  now: number
  version: string
}

type State = {
  frame: string
  turn: number
  since: number
  flipMs: number
  nextFeedAt: number
}

// --- colors ------------------------------------------------------------
const UP_GREEN = '#3fb950'
const DOWN_RED = '#e5534b'
const FLAT = '#9aa0a6'
const DIM = '#6e7681'
const HEAD = '#a6aebb'
const SYMBOL = '#79a8ff'
const RULE = '#2d333b'
const ORANGE = '#d97757'
const WHITE = '#f0f3f6'
const ROW_HILIGHT = '#1b2436'
const CREDIT = 'darrell_tw_'

// --- split-flap row-turn animation (ported from tw-stock-mod's board.tsx) --
const ANIM_TICK_MS = 50 // how often the frame is re-derived, not how often it draws
const FLAP_MS = 28 // one flap step
const STAGGER = 1 // flaps a column waits behind the column to its left
const MAX_FLAPS = 12 // longest riffle a single flap takes, so the wave stays brisk
const EDGE = ['█', '▓'] // the wave front
const ROW_STAGGER = 2 // flaps each quote row waits behind the row above it
const PAGE_ROW_STAGGER = 5 // a page turn's rows lag further apart than a price update's
const FLIP_MS = 1450 // a price update's full turn
const PAGE_FLIP_MS = 1100 // a page turn's full turn
const RESTING = Number.MAX_SAFE_INTEGER

// no blank on the numeric drum: a space riffling through a price reads as a
// glitch. Crypto tickers are always ASCII, so the symbol column never needs
// a CJK wipe the way tw-stock-mod's coin/company names did.
const NUM_DRUM = '0123456789'
const TEXT_DRUM = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** one flap `step` turns into its journey from `from` to `to` */
function flapChar(from: string, to: string, drum: string, step: number, together: boolean): string {
  if (from === to) return to
  const i = drum.indexOf(from)
  const j = drum.indexOf(to)
  if (i < 0 || j < 0) return step >= 0 ? to : from // painted, not flapped
  if (step < 0) return from
  const full = (j - i + drum.length) % drum.length
  const distance = together ? MAX_FLAPS : Math.min(full, MAX_FLAPS)
  if (step >= distance) return to
  const start = (((j - distance) % drum.length) + drum.length) % drum.length
  return drum[(start + step) % drum.length]
}

function flapSpan(width: number, stagger: number): number {
  return width * stagger + EDGE.length + MAX_FLAPS
}

/** a whole field mid-turn; `stagger` 0 turns the whole field at once */
function flapField(from: string, to: string, drum: string, flap: number, stagger = STAGGER): string {
  if (flap >= flapSpan(to.length, stagger)) return to
  const together = stagger === 0
  let out = ''
  for (let i = 0; i < to.length; i++) {
    const step = flap - i * stagger
    if (step < 0) out += from[i] ?? ' '
    else if (step < EDGE.length) out += EDGE[step]
    else out += flapChar(from[i] ?? ' ', to[i], drum, step - EDGE.length, together)
  }
  return out
}

function padRight(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - dispWidth(text)))
}
function padLeft(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - dispWidth(text))) + text
}

/** how far into its turn the quote rows are; RESTING once they have settled */
function rowFlap(t: number, since: number, flipMs: number): number {
  const age = t - since
  return age >= 0 && age < flipMs ? Math.floor(age / FLAP_MS) : RESTING
}

/** whole seconds until the next feed request; -1 when nothing is fetching */
function secondsToFeed(t: number, nextFeedAt: number): number {
  if (!nextFeedAt) return -1
  return Math.max(0, Math.min(999, Math.ceil((nextFeedAt - t) / 1000)))
}

function frameId(t: number, st: State): string {
  return `${rowFlap(t, st.since, st.flipMs)}:${secondsToFeed(t, st.nextFeedAt)}`
}
function stillFrameId(t: number, st: State): string {
  return `still:${secondsToFeed(t, st.nextFeedAt)}`
}

// per-instance frame clock, same lifetime reasoning as tw-stock-mod's board:
// a WeakMap keyed on the surface ties the timer to the same lifetime as the
// instance, so a remounted board starts its own clock.
const frameClocks = new WeakMap<object, { ms: number; cancel: () => void }>()

const TABLE_ROWS = 8 // header, rule, 5 quote rows, footer
const TABLE_QUOTE_ROWS = 5
const MAX_TABLE_QUOTES = TABLE_QUOTE_ROWS * 2 // two-column mode holds 2 coins a row

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

type Cell = { ch: string; fg?: string; bg?: string }

class Row {
  cells: Cell[] = []
  width(): number {
    return this.cells.reduce((w, c) => w + charWidth(c.ch), 0)
  }
  padTo(col: number) {
    while (this.width() < col) this.cells.push({ ch: ' ' })
  }
  put(col: number, text: string, fg?: string, bg?: string) {
    this.padTo(Math.max(0, col))
    for (const ch of Array.from(text)) this.cells.push({ ch, fg, bg })
  }
  putRight(right: number, text: string, fg?: string, bg?: string) {
    this.put(right - dispWidth(text), text, fg, bg)
  }
  putRightIfFits(right: number, text: string, fg?: string, bg?: string): boolean {
    if (right - dispWidth(text) < this.width() + 1) return false
    this.putRight(right, text, fg, bg)
    return true
  }
  fillBg(bg: string, width: number) {
    this.padTo(width)
    this.cells = this.cells.map(c => ({ ...c, bg: c.bg ?? bg }))
  }
}

// groups consecutive same-color cells into one span
function rowChildren(row: Row, Text: TextTag): RenderNode[] {
  const out: RenderNode[] = []
  let run: { text: string; fg?: string; bg?: string } | null = null
  const flush = () => {
    if (!run) return
    out.push(!run.fg && !run.bg ? run.text : <Text color={run.fg} backgroundColor={run.bg}>{run.text}</Text>)
    run = null
  }
  for (const c of row.cells) {
    if (run && run.fg === c.fg && run.bg === c.bg) run.text += c.ch
    else {
      flush()
      run = { text: c.ch, fg: c.fg, bg: c.bg }
    }
  }
  flush()
  return out
}

function thousands(value: number, decimals = 2): string {
  const neg = value < 0
  const [int, frac] = Math.abs(value).toFixed(decimals).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`
}
function signed(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return sign + thousands(Math.abs(value), decimals)
}

/**
 * Crypto prices range from fractions of a cent (some altcoins) to six
 * figures (BTC) - a flat decimal count either drowns a cheap coin in
 * trailing zeros or throws away BTC's only meaningful digits, so this
 * scales to the price's own magnitude.
 */
function priceDecimals(price: number): number {
  if (price >= 1000) return 0
  if (price >= 1) return 2
  return 4
}

/** 24h volume runs into the billions for BTC - compact it or the column needs 15+ characters */
function compactUsd(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`
  return `$${thousands(value, 2)}`
}

function pctText(v: number): string {
  return `${v > 0 ? '▲' : v < 0 ? '▼' : '-'} ${signed(v)}%`
}

// up = green, down = red: the crypto-market convention. tw-stock-mod flips
// this per market (紅漲綠跌 for Taiwan); crypto-band only ever shows one
// market, so this never needs a market argument.
function tone(value: number): string {
  if (value === 0) return FLAT
  return value > 0 ? UP_GREEN : DOWN_RED
}

type Layout = {
  symCol: number
  priceCol: number
  priceRight: number
  pct1hRight: number
  pct24hRight: number
  volRight: number
}

// right-anchored numeric columns, capped so the table does not stretch
// across a very wide terminal.
function layout(width: number): Layout {
  const w = Math.max(50, width)
  const volRight = Math.min(w - 1, 78)
  const pct24hRight = volRight - 11
  const pct1hRight = pct24hRight - 11
  const priceRight = pct1hRight - 11
  const priceCol = priceRight - 12 // reserved for the widest price, e.g. 123,456.78
  return { symCol: 1, priceCol, priceRight, pct1hRight, pct24hRight, volRight }
}

// Two coins per row, when the page holds more than 5 (register.tsx decides
// when; see BoardProps.columns). 1h% and 24h量 have no room next to a
// second coin, so each half only carries 幣種/價格/24h%.
type HalfLayout = { symCol: number; priceCol: number; priceRight: number; pct24hRight: number }

const TWO_COL_MAX = 96 // two halves need more room than one table's 78-column cap
const TWO_COL_GUTTER = 6 // clear columns between the halves
// Half-width floor: 幣種 (up to 4 chars + gap, 6) + widest price e.g.
// "123,456.78" + gap (11) + widest 24h% e.g. "▲ +100.00%" + gap (11) = 28.
const MIN_HALF_WIDTH = 28
const MIN_TWO_COL_WIDTH = MIN_HALF_WIDTH * 2 + TWO_COL_GUTTER

function layout2(width: number): [HalfLayout, HalfLayout] {
  const cap = Math.min(width - 1, TWO_COL_MAX)
  const halfW = Math.floor((cap - TWO_COL_GUTTER) / 2)
  const mkHalf = (leftEdge: number): HalfLayout => {
    const pct24hRight = leftEdge + halfW
    const priceRight = pct24hRight - 11
    const priceCol = priceRight - 9
    return { symCol: leftEdge, priceCol, priceRight, pct24hRight }
  }
  const left = mkHalf(1)
  const right = mkHalf(left.pct24hRight + 1 + TWO_COL_GUTTER)
  return [left, right]
}

/** whether a terminal this wide can lay out two readable halves */
function fitsTwoColumns(width: number): boolean {
  return Math.min(width - 1, TWO_COL_MAX) >= MIN_TWO_COL_WIDTH
}

/** a numeric field mid-turn, right-anchored; both texts share one padded width so the column never jitters */
function flapRight(row: Row, right: number, from: string, to: string, fg: string, turn: number, left: number, stagger = STAGGER) {
  const width = Math.max(dispWidth(from), dispWidth(to))
  const lead = stagger === 0 ? 0 : (right - width - left) * stagger
  const text = flapField(padLeft(from, width), padLeft(to, width), NUM_DRUM, turn - lead, stagger)
  row.putRight(right, text, fg)
}

/** a quote row's 幣種 cell - flapped on a page/rank turn (crypto tickers are always ASCII, always on TEXT_DRUM) */
function drawSymbolCell(r: Row, symCol: number, q: QuoteRow, rowStart: number, turned: boolean): void {
  if (turned && rowStart !== RESTING) {
    const wasSymbol = q.was?.symbol ?? q.symbol
    const w = Math.max(dispWidth(q.symbol), dispWidth(wasSymbol))
    r.put(symCol, flapField(padRight(wasSymbol, w), padRight(q.symbol, w), TEXT_DRUM, rowStart, 0), SYMBOL)
  } else {
    r.put(symCol, q.symbol, SYMBOL)
  }
}

/** one coin inside a two-column table row: 幣種/價格/24h% only, at the given half's own columns */
function drawTwoColQuote(r: Row, half: HalfLayout, q: QuoteRow, rowTurn: number, slot: number): void {
  const turned = q.was?.id !== undefined
  const rowStart = turned ? rowTurn - slot * PAGE_ROW_STAGGER : RESTING
  drawSymbolCell(r, half.symCol, q, rowStart, turned)

  const color = tone(q.pct24h)
  const turn = q.was ? rowTurn - slot * (turned ? PAGE_ROW_STAGGER : ROW_STAGGER) : RESTING
  const was = q.was ?? q
  const stagger = turned ? 0 : STAGGER
  const dec = priceDecimals(q.price)
  flapRight(r, half.priceRight, thousands(was.price, dec), thousands(q.price, dec), WHITE, turn, half.priceCol, stagger)
  flapRight(r, half.pct24hRight, pctText(was.pct24h), pctText(q.pct24h), color, turn, half.priceCol, stagger)
}

type TailPiece = { text: string; fg: string }
const TAIL_GAP = 3

/**
 * The footer's right-hand end: the clock the last good snapshot was taken
 * at, its live dot, the feed countdown, the source tag (or 資料延遲 - see
 * BoardProps.stale) and the credit sign-off. A tight row drops the
 * countdown first, then the credit, then the clock and dot, keeping the
 * source tag as the one thing that never goes - it is what says whether the
 * numbers on screen are still trustworthy.
 */
function putFooterTail(
  row: Row,
  right: number,
  clockText: string,
  dotChar: string,
  countdownText: string,
  sourceTag: string,
  sourceTagShort: string,
): void {
  const clockDot: TailPiece[] = [
    { text: clockText, fg: DIM },
    ...(dotChar ? [{ text: ` ${dotChar}`, fg: ORANGE }] : []),
  ]
  const withCountdown = (base: TailPiece[]): TailPiece[] => [...base, { text: countdownText, fg: DIM }]
  const withSource = (base: TailPiece[]): TailPiece[] => [...base, { text: ` ${sourceTag}`, fg: DIM }]
  const withShortSource = (base: TailPiece[]): TailPiece[] => [...base, { text: ` ${sourceTagShort}`, fg: DIM }]
  const withCredit = (base: TailPiece[]): TailPiece[] => [...base, { text: ` · ${CREDIT}`, fg: DIM }]
  const ladder: TailPiece[][] = [
    withCredit(withSource(withCountdown(clockDot))),
    withCredit(withShortSource(withCountdown(clockDot))),
    withCredit(withShortSource(clockDot)),
    withShortSource(clockDot),
    [{ text: sourceTagShort, fg: DIM }],
  ]
  for (const [rung, pieces] of ladder.entries()) {
    const gap = rung === ladder.length - 1 ? 1 : TAIL_GAP
    const width = pieces.reduce((w, p) => w + dispWidth(p.text), 0)
    if (right - width < row.width() + gap) continue
    let col = right - width
    for (const p of pieces) {
      row.put(col, p.text, p.fg)
      col += dispWidth(p.text)
    }
    return
  }
}

function hhmmss(ms: number): string {
  if (!ms) return '--:--:--'
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export default function CryptoBandBoard(props: BoardProps | undefined, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements

  // No quotes yet (first launch, before the first fetch has landed) draws
  // nothing rather than a demo/placeholder price - there is no fake data to
  // fall back to in this module at all.
  if (!props || !props.quotes || props.quotes.length === 0) {
    return <Text dimColor>crypto-band: 等待報價中…</Text>
  }

  const isPageTurn = props.quotes.some(q => q.was?.id !== undefined)
  const still = props.animation === 'off'

  if (!surface.state) {
    // the first snapshot is not an update, so the rows do not turn for it
    const seed: State = { frame: '', turn: props.turn, since: 0, flipMs: FLIP_MS, nextFeedAt: props.nextFeedAt }
    surface.setState({ ...seed, frame: still ? stillFrameId(Date.now(), seed) : frameId(Date.now(), seed) })
  }

  // A still board only repaints for the countdown (one frame a second); with
  // the countdown off too it wants no timer at all.
  const wanted = still ? (props.countdown && props.nextFeedAt ? 1000 : 0) : ANIM_TICK_MS
  const running = frameClocks.get(surface)
  if (!running || running.ms !== wanted) {
    running?.cancel()
    const cancel =
      wanted > 0
        ? surface.every(wanted, () => {
            const s = surface.state
            if (!s) return
            const id = wanted === 1000 ? stillFrameId(Date.now(), s) : frameId(Date.now(), s)
            if (s.frame !== id) surface.setState({ ...s, frame: id })
          })
        : () => {}
    frameClocks.set(surface, { ms: wanted, cancel })
  }

  const st = surface.state
  let turning = st
  if (st && props.turn !== st.turn) {
    turning = { ...st, turn: props.turn, since: Date.now(), flipMs: isPageTurn ? PAGE_FLIP_MS : FLIP_MS, nextFeedAt: props.nextFeedAt }
    surface.setState(turning)
  } else if (st && props.nextFeedAt !== st.nextFeedAt) {
    turning = { ...st, nextFeedAt: props.nextFeedAt }
    surface.setState(turning)
  }
  const rowTurn = !still && turning ? rowFlap(Date.now(), turning.since, turning.flipMs) : RESTING
  const tillFeed = props.countdown ? secondsToFeed(Date.now(), props.nextFeedAt) : -1

  const lay = layout(surface.columns || 80)
  const rows = Array.from({ length: TABLE_ROWS }, () => new Row())
  const quotes = props.quotes.slice(0, MAX_TABLE_QUOTES)

  const sourceTag = props.stale ? `資料延遲 · 更新 ${hhmmss(props.lastUpdateAt)}` : 'CoinGecko 即時'
  const sourceTagShort = props.stale ? '資料延遲' : 'CoinGecko'
  const fullTag = props.version ? `${sourceTag} · ${props.version}` : sourceTag

  const halves = props.columns === 2 && fitsTwoColumns(surface.columns || 80) ? layout2(surface.columns || 80) : undefined
  const rightEdge = halves ? halves[1].pct24hRight : lay.volRight

  const arrowFor = (key: SortKey, label: string) => (props.sorted && props.sortKey === key ? `↓${label}` : label)

  const head = rows[0]
  if (halves) {
    for (const half of halves) {
      head.put(half.symCol, '幣種', HEAD)
      head.putRight(half.priceRight, '價格', HEAD)
      head.putRight(half.pct24hRight, arrowFor('change24h', '24h%'), HEAD)
    }
  } else {
    head.put(lay.symCol, '幣種', HEAD)
    head.putRight(lay.priceRight, '價格', HEAD)
    head.putRight(lay.pct1hRight, arrowFor('change1h', '1h%'), HEAD)
    head.putRight(lay.pct24hRight, arrowFor('change24h', '24h%'), HEAD)
    head.putRight(lay.volRight, arrowFor('volume', '24h量'), HEAD)
  }

  // the rule doubles as the page indicator
  const pageTag = props.pageCount > 1 ? ` ${props.page + 1}/${props.pageCount} ` : ''
  const ruleW = Math.max(0, rightEdge - lay.symCol - dispWidth(pageTag))
  rows[1].put(lay.symCol, '─'.repeat(ruleW), RULE)
  if (pageTag) rows[1].put(rows[1].width(), pageTag, DIM)

  const single = halves ? [] : quotes.slice(0, TABLE_QUOTE_ROWS)
  let topMover = 0
  for (let i = 1; i < single.length; i++) {
    if (Math.abs(single[i].pct24h) > Math.abs(single[topMover].pct24h)) topMover = i
  }

  if (halves) {
    // Column-major off the existing sort: the left half is ranks 1..5, the
    // right half ranks 6..10 - no single "this row" to stripe when it can
    // hold two unrelated coins, so the top-mover highlight is single-column only.
    for (let i = 0; i < TABLE_QUOTE_ROWS; i++) {
      const r = rows[2 + i]
      const left = quotes[i]
      const right = quotes[i + TABLE_QUOTE_ROWS]
      if (left) drawTwoColQuote(r, halves[0], left, rowTurn, i)
      if (right) drawTwoColQuote(r, halves[1], right, rowTurn, i)
    }
  } else {
    for (let i = 0; i < single.length; i++) {
      const q = single[i]
      const r = rows[2 + i]
      const turned = q.was?.id !== undefined
      const rowStart = turned ? rowTurn - i * PAGE_ROW_STAGGER : RESTING
      drawSymbolCell(r, lay.symCol, q, rowStart, turned)

      const color = tone(q.pct24h)
      const turn = q.was ? rowTurn - i * (turned ? PAGE_ROW_STAGGER : ROW_STAGGER) : RESTING
      const was = q.was ?? q
      const left = lay.priceCol
      const stagger = turned ? 0 : STAGGER
      const dec = priceDecimals(q.price)
      flapRight(r, lay.priceRight, thousands(was.price, dec), thousands(q.price, dec), WHITE, turn, left, stagger)
      flapRight(r, lay.pct1hRight, pctText(was.pct1h), pctText(q.pct1h), tone(q.pct1h), turn, left, stagger)
      flapRight(r, lay.pct24hRight, pctText(was.pct24h), pctText(q.pct24h), color, turn, left, stagger)
      flapRight(r, lay.volRight, compactUsd(was.volume24h), compactUsd(q.volume24h), DIM, turn, left, stagger)
      if (props.highlight && i === topMover) r.fillBg(ROW_HILIGHT, lay.volRight)
    }
  }

  // row 7: the clock the last good snapshot was taken at, its live dot (frozen
  // while stale - it only steps on a successful fetch), the feed countdown
  // and the source tag.
  const foot = rows[7]
  putFooterTail(
    foot,
    rightEdge,
    hhmmss(props.lastUpdateAt),
    props.seq % 2 === 0 ? '●' : '○',
    tillFeed >= 0 ? ` · ${tillFeed}s` : '',
    fullTag,
    sourceTagShort,
  )

  for (const r of rows) if (r.cells.length === 0) r.cells.push({ ch: ' ' })
  return (
    <Box flexDirection="column">
      {rows.map(r => (
        <Text>{rowChildren(r, Text)}</Text>
      ))}
    </Box>
  )
}
