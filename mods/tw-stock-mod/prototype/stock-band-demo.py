#!/usr/bin/env python3
"""Terminal animation: a stock watchlist band drawn above a prompt box, in the
style of a broker's watchlist table (symbol / price / change$ / change%).
Standard library only. This file is the VISUAL SPEC for
mods/cc-stock-band/hooks/board.tsx - layout columns, colors, badges, the
candle drawing and the market-session rules are ported from here.

Taiwan hours show the Taiwan watchlist (red = up, green = down); US hours show
the US watchlist (green = up, red = down). Prices here are FAKE: a deterministic
sine walk off each symbol's previous close, so the band animates with no API.

Usage:
    python3 stock-band-demo.py                     # live, market picked by the clock
    python3 stock-band-demo.py --market tw         # force the Taiwan board
    python3 stock-band-demo.py --market us --phase closed
    python3 stock-band-demo.py --view chart        # the candle panel instead
    python3 stock-band-demo.py --columns 2         # force the two-column table
    python3 stock-band-demo.py --snapshot tw-open  # print one frame as JSON
"""

import argparse
import json
import math
import sys
import time
import unicodedata

BAND_WIDTH = 80
TABLE_ROWS = 8  # header, rule, 5 quote rows, footer - the control row above is separate
CHART_ROWS = 9  # title, 6 candle rows, axis, footer

# --- colors ----------------------------------------------------------------
UP_GREEN = (0x3F, 0xB9, 0x50)
DOWN_RED = (0xE5, 0x53, 0x4B)
FLAT = (0x9A, 0xA0, 0xA6)
GRAY = (0x80, 0x80, 0x80)
DIM = (0x6E, 0x76, 0x81)
HEAD = (0xA6, 0xAE, 0xBB)
SYMBOL = (0x79, 0xA8, 0xFF)  # the blue ticker links in the reference screenshot
ORANGE = (0xD9, 0x77, 0x57)
MOON_BLUE = (0x8A, 0xB4, 0xF8)
WHITE = (0xF0, 0xF3, 0xF6)
ROW_HILIGHT = (0x1B, 0x24, 0x36)  # selected-row band, like the reference screenshot
CREDIT = "darrell_tw_"  # what the band signs itself with, bottom right

# --- watchlists -------------------------------------------------------------
# prev_close is the change basis; amp/phase/period/drift only exist to fake a
# price walk (a real feed replaces all of it via the quotes file). All 20
# Taiwan prev_close values (and the 5 US ones) were read directly off Yahoo's
# spark endpoint on 2026-09-16 ~12:39 Taipei time and cross-checked against
# 證交所 MIS's own `y` field (exact match on every Taiwan symbol) - the same
# measurement pass as hooks/register.tsx's TW_LIST, so the two stay in sync.
TW_LIST = [
    dict(code="2330", name="台積電", prev_close=2385, amp=0.9, phase=0.0, period=47.0, drift=1.1),
    dict(code="2317", name="鴻海", prev_close=246.5, amp=0.7, phase=1.7, period=61.0, drift=0.35),
    dict(code="2454", name="聯發科", prev_close=4430, amp=1.1, phase=3.1, period=53.0, drift=-0.6),
    dict(code="0050", name="元大台灣50", prev_close=106.25, amp=0.4, phase=0.8, period=71.0, drift=0.55),
    dict(code="006208", name="富邦台50", prev_close=243.5, amp=0.35, phase=2.4, period=67.0, drift=-0.15),
    dict(code="2412", name="中華電", prev_close=143.5, amp=0.25, phase=0.5, period=83.0, drift=0.1),
    dict(code="2881", name="富邦金", prev_close=151.0, amp=0.5, phase=1.2, period=57.0, drift=0.2),
    dict(code="2882", name="國泰金", prev_close=110.0, amp=0.5, phase=2.0, period=63.0, drift=-0.15),
    dict(code="2891", name="中信金", prev_close=69.7, amp=0.45, phase=2.8, period=69.0, drift=0.1),
    dict(code="3008", name="大立光", prev_close=6055, amp=1.4, phase=3.5, period=41.0, drift=-0.8),
    dict(code="2603", name="長榮", prev_close=233.5, amp=1.6, phase=4.2, period=39.0, drift=1.0),
    dict(code="1301", name="台塑", prev_close=62.0, amp=0.35, phase=4.9, period=77.0, drift=-0.2),
    dict(code="2002", name="中鋼", prev_close=18.65, amp=0.3, phase=5.5, period=87.0, drift=0.05),
    dict(code="2308", name="台達電", prev_close=1670, amp=0.9, phase=0.2, period=49.0, drift=0.5),
    dict(code="3711", name="日月光投控", prev_close=592.0, amp=0.8, phase=0.9, period=52.0, drift=0.3),
    dict(code="2379", name="瑞昱", prev_close=703.0, amp=1.0, phase=1.6, period=45.0, drift=-0.4),
    dict(code="3034", name="聯詠", prev_close=541.0, amp=0.95, phase=2.3, period=48.0, drift=0.35),
    dict(code="2357", name="華碩", prev_close=928.0, amp=0.7, phase=3.0, period=59.0, drift=-0.25),
    dict(code="2382", name="廣達", prev_close=333.0, amp=1.3, phase=3.7, period=43.0, drift=0.9),
    dict(code="2303", name="聯電", prev_close=138.5, amp=0.6, phase=4.4, period=64.0, drift=-0.3),
]

US_LIST = [
    dict(code="NVDA", name="NVIDIA",
         prev_close=182.4, amp=1.3, phase=0.4, period=43.0, drift=0.9),
    dict(code="TSLA", name="Tesla",
         prev_close=421.6, amp=1.8, phase=2.2, period=37.0, drift=-1.2),
    dict(code="NET", name="Cloudflare",
         prev_close=214.2, amp=1.5, phase=4.0, period=59.0, drift=0.4),
    dict(code="QQQ", name="Invesco QQQ",
         prev_close=604.8, amp=0.5, phase=1.1, period=73.0, drift=0.25),
    dict(code="VOO", name="Vanguard 500",
         prev_close=598.3, amp=0.4, phase=3.6, period=79.0, drift=-0.1),
]

# Single-column table: PAGE_1COL quotes, 代號/名稱/價格/變更$/變更%. Past that
# the two-column table takes over (see columns_for()): PAGE_2COL quotes, two
# to a row, 代號/名稱/價格/變更% only - 變更$ has no room next to a second
# symbol. Mirrors hooks/register.tsx's PAGE_SIZE_1COL / PAGE_SIZE_2COL.
PAGE_1COL = 5
PAGE_2COL = 10

MARKETS = {
    "tw": dict(
        label="台股", list=TW_LIST, up=DOWN_RED, down=UP_GREEN,
        hours="09:00-13:30",
        index_name="加權指數", index_close=24051.7, index_amp=0.6, index_drift=0.75,
        decimals=2, currency="",
    ),
    "us": dict(
        label="美股", list=US_LIST, up=UP_GREEN, down=DOWN_RED,
        hours="09:30-16:00 ET",
        index_name="NASDAQ", index_close=22105.4, index_amp=0.5, index_drift=-0.35,
        decimals=2, currency="$",
    ),
}


def disp_width(s):
    w = 0
    for ch in s:
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def to_hex(rgb):
    return "#%02x%02x%02x" % rgb


RESET = "\x1b[0m"
HIDE_CURSOR = "\x1b[?25l"
SHOW_CURSOR = "\x1b[?25h"


class Row:
    """One line of the band; every cell carries its own fg/bg (RGB or None)."""

    def __init__(self):
        self.cells = []  # (ch, fg, bg)

    def width(self):
        return sum(2 if unicodedata.east_asian_width(c[0]) in ("W", "F") else 1
                   for c in self.cells)

    def pad_to(self, col):
        while self.width() < col:
            self.cells.append((" ", None, None))

    def put(self, col, text, fg=None, bg=None):
        self.pad_to(max(0, col))
        for ch in text:
            self.cells.append((ch, fg, bg))

    def put_right(self, right, text, fg=None, bg=None):
        self.put(right - disp_width(text), text, fg, bg)

    def put_right_if_fits(self, right, text, fg=None, bg=None):
        """Right-align only if it still fits: put() can only append."""
        if right - disp_width(text) < self.width() + 1:
            return False
        self.put_right(right, text, fg, bg)
        return True

    def put_cells(self, col, cells):
        self.pad_to(max(0, col))
        self.cells.extend(cells)

    def fill_bg(self, bg, width):
        """Paint the whole line's background, like the selected row in the
        reference screenshot: pad out to the band width, then set bg on every
        cell that does not already carry one (badges keep their own)."""
        self.pad_to(width)
        self.cells = [(ch, fg, bg if b is None else b) for ch, fg, b in self.cells]

    def to_ansi(self):
        out = []
        for ch, fg, bg in self.cells:
            prefix = ""
            if fg is not None:
                prefix += "\x1b[38;2;%d;%d;%dm" % fg
            if bg is not None:
                prefix += "\x1b[48;2;%d;%d;%dm" % bg
            out.append(prefix + ch + RESET if prefix else ch)
        return "".join(out)

    def to_json(self):
        return [[ch, to_hex(fg) if fg else None, to_hex(bg) if bg else None]
                for ch, fg, bg in self.cells]


# --- market sessions --------------------------------------------------------
# Taipei is UTC+8 all year. US eastern is UTC-5, UTC-4 between the 2nd Sunday
# of March and the 1st Sunday of November (the TSX port does the same
# arithmetic instead of trusting a tz database inside the hooks sandbox).
def us_eastern_offset_hours(epoch_sec):
    t = time.gmtime(epoch_sec)
    year, month, day = t.tm_year, t.tm_mon, t.tm_mday
    if month < 3 or month > 11:
        return -5
    if 3 < month < 11:
        return -4
    # weekday of the 1st of this month, 0 = Sunday
    first_dow = time.gmtime(time.mktime((year, month, 1, 12, 0, 0, 0, 0, 0)) -
                            time.timezone).tm_wday
    first_sunday = 1 + ((6 - first_dow) % 7)
    if month == 3:
        return -4 if day >= first_sunday + 7 else -5
    return -5 if day >= first_sunday else -4


def local_parts(epoch_sec, offset_hours):
    t = time.gmtime(epoch_sec + offset_hours * 3600)
    # tm_wday: Monday = 0 .. Sunday = 6
    return t.tm_wday, t.tm_hour * 60 + t.tm_min, t


def session_for(epoch_sec, market):
    """-> (phase, minutes_into_session). phase in open / closed."""
    if market == "tw":
        dow, mins, _ = local_parts(epoch_sec, 8)
        open_min, close_min = 9 * 60, 13 * 60 + 30
    else:
        dow, mins, _ = local_parts(epoch_sec, us_eastern_offset_hours(epoch_sec))
        open_min, close_min = 9 * 60 + 30, 16 * 60
    if dow <= 4 and open_min <= mins < close_min:
        return "open", mins - open_min
    return "closed", 0


SESSION_MINS = {"tw": (9 * 60, 13 * 60 + 30), "us": (9 * 60 + 30, 16 * 60)}
PREVIEW_MINS = 60  # how early a market takes the band over before it opens


def _market_offset(epoch_sec, market):
    return 8 if market == "tw" else us_eastern_offset_hours(epoch_sec)


def minutes_to_open(epoch_sec, market):
    open_min, _ = SESSION_MINS[market]
    dow, mins, _ = local_parts(epoch_sec, _market_offset(epoch_sec, market))
    if dow <= 4 and mins < open_min:
        return open_min - mins
    days, d = 1, (dow + 1) % 7
    while d > 4:
        days, d = days + 1, (d + 1) % 7
    return days * 1440 - mins + open_min


def minutes_since_close(epoch_sec, market):
    _, close_min = SESSION_MINS[market]
    dow, mins, _ = local_parts(epoch_sec, _market_offset(epoch_sec, market))
    if dow <= 4 and mins >= close_min:
        return mins - close_min
    days, d = 1, (dow + 6) % 7
    while d > 4:
        days, d = days + 1, (d + 6) % 7
    return days * 1440 - close_min + mins


def pick_market(epoch_sec):
    """Same rule as mods/cc-stock-band/hooks/register.tsx (which is the runtime
    source of truth): the trading market, else the one that closed most
    recently, unless the other one opens within the hour."""
    for m in ("tw", "us"):
        if session_for(epoch_sec, m)[0] == "open":
            return m, "open"
    tw_open, us_open = minutes_to_open(epoch_sec, "tw"), minutes_to_open(epoch_sec, "us")
    if min(tw_open, us_open) <= PREVIEW_MINS:
        return ("tw" if tw_open <= us_open else "us"), "closed"
    return ("tw" if minutes_since_close(epoch_sec, "tw") <= minutes_since_close(epoch_sec, "us") else "us"), "closed"


def clock_str(epoch_sec, market):
    off = 8 if market == "tw" else us_eastern_offset_hours(epoch_sec)
    t = time.gmtime(epoch_sec + off * 3600)
    return "%02d:%02d:%02d" % (t.tm_hour, t.tm_min, t.tm_sec)


# --- fake quotes ------------------------------------------------------------
def price_at(sym, t):
    pct = (sym["drift"]
           + sym["amp"] * math.sin(2 * math.pi * t / sym["period"] + sym["phase"])
           + 0.35 * sym["amp"] * math.sin(2 * math.pi * t / (sym["period"] / 4.7) + sym["phase"] * 2.3))
    return round(sym["prev_close"] * (1 + pct / 100.0), 2)


BAR_INTERVAL = 3.0  # seconds of demo time per fake K bar


def quote_for(sym, t, bars=0):
    """A quote plus the OHLC history the chart view needs; here it is sampled
    off the same sine walk a real feed's bars would replace."""
    price = price_at(sym, t)
    change = round(price - sym["prev_close"], 2)
    pct_real = (change / sym["prev_close"]) * 100.0 if sym["prev_close"] else 0.0
    ohlc = []
    for i in range(bars):
        t1 = t - (bars - 1 - i) * BAR_INTERVAL
        o = price_at(sym, t1 - BAR_INTERVAL)
        c = price_at(sym, t1)
        mid = (o + c) / 2
        # a deterministic wiggle stands in for the bar's real high/low
        span = abs(c - o) / 2 + mid * 0.0008 * (1 + math.sin(t1 * 1.7 + sym["phase"]) ** 2)
        ohlc.append((o, max(o, c) + span, min(o, c) - span, c))
    return dict(sym=sym, price=price, change=change, pct=pct_real, bars=ohlc)


def thousands(value, decimals=2):
    return f"{value:,.{decimals}f}"


def signed(value, decimals=2):
    body = thousands(abs(value), decimals)
    return ("+" if value > 0 else "-" if value < 0 else "") + body


def tone(market, value):
    conf = MARKETS[market]
    if value > 0:
        return conf["up"]
    if value < 0:
        return conf["down"]
    return FLAT


def pct_text(v):
    arrow = "▲" if v > 0 else "▼" if v < 0 else "-"
    return f"{arrow} {signed(v)}%"


# --- layout (the numbers board.tsx reproduces) -----------------------------
def layout(width):
    """Single-column table. Price is the widest, brightest column and sits
    where the eye lands first among the numbers."""
    w = max(46, width)
    pct_right = min(w - 1, 74)
    chg_right = pct_right - 9
    price_right = chg_right - 11  # wider: price is the main number here
    price_col = price_right - 10  # reserved for the widest price, e.g. 1,396.14
    name_col = 9
    return dict(
        badge_col=1, sym_col=1, name_col=name_col, price_col=price_col,
        price_right=price_right, chg_right=chg_right, pct_right=pct_right,
        show_name=price_col - name_col >= 8, width=w,
    )


# Two symbols a row, once the watchlist holds more than PAGE_1COL (see
# columns_for()). 變更$ has no room next to a second symbol, so each half
# only carries 代號/名稱/價格/變更%, right-anchored the same way the
# single-column table anchors them.
TWO_COL_MAX = 104  # two halves need more room than one table's 74-column cap
TWO_COL_GUTTER = 6  # clear columns between the halves, so 變更% and the next
# 代號 do not read as one run of digits
# Half-width floor, left to right: 代號 up to 6 chars + 1 gap (7) + a
# 4-character name + 1 gap (9 - CJK counts double, so 4 characters is 8
# columns) + the widest price, e.g. "1,396.14", + 1 gap (9) + the widest
# 變更% field, e.g. "▼ -100.00%" (10). Below this a half cannot hold
# 代號 + a name + 價格 + 變更% without cutting one of them, so the two-column
# table falls back to the single-column one instead of squeezing:
# 7 + 9 + 9 + 10 = 35 per half, twice that plus the gutter = 76. layout2()
# spends that 76 out of `width - 1` (the same one column short of the raw
# width `layout()` reserves), so the terminal itself needs to be 77 columns
# or wider before two columns fit.
MIN_HALF_WIDTH = 35
MIN_TWO_COL_WIDTH = MIN_HALF_WIDTH * 2 + TWO_COL_GUTTER  # 76, out of `width - 1`


def layout2(width):
    cap = min(width - 1, TWO_COL_MAX)
    half_w = (cap - TWO_COL_GUTTER) // 2

    def mk_half(left_edge):
        pct_right = left_edge + half_w
        price_right = pct_right - 11
        price_col = price_right - 9
        name_col = left_edge + 7
        return dict(sym_col=left_edge, name_col=name_col, price_col=price_col,
                    price_right=price_right, pct_right=pct_right,
                    show_name=price_col - name_col >= 8)

    left = mk_half(1)
    right = mk_half(left["pct_right"] + 1 + TWO_COL_GUTTER)
    return left, right


def fits_two_columns(width):
    return min(width - 1, TWO_COL_MAX) >= MIN_TWO_COL_WIDTH


def columns_for(mode, list_len, width):
    """Resolve `mode` ("auto"/1/2) the way register.tsx's effectiveColumns()
    does, then fall back to 1 at render time if the terminal is too narrow -
    the same two-step board.tsx applies."""
    columns = mode if mode in (1, 2) else (2 if list_len > PAGE_1COL else 1)
    if columns == 2 and not fits_two_columns(width):
        return 1
    return columns


def put_footer_tail(row, right, stamp_core, dot_char, source_tag):
    """The table footer's right-hand end: the clock (dot appended while the
    market is open), then the source tag, then the credit sign-off - dropped
    in that order on a narrow row, so the source tag is the last thing that
    ever goes. Mirrors board.tsx's putFooterTail, minus the countdown, which
    this static demo has nothing to count down to."""
    pieces = [stamp_core]
    if dot_char:
        pieces.append(dot_char)
    clock_dot = " ".join(pieces)
    for tail in (f"{clock_dot} {source_tag} · {CREDIT}", f"{clock_dot} {source_tag}", source_tag):
        if row.put_right_if_fits(right, tail, DIM):
            return


def render(market, phase, t, width=BAND_WIDTH, epoch_sec=None, sort=True, columns="auto"):
    conf = MARKETS[market]
    epoch_sec = time.time() if epoch_sec is None else epoch_sec
    all_quotes = [quote_for(s, t) for s in conf["list"]]
    if sort:
        all_quotes.sort(key=lambda q: q["pct"], reverse=True)

    cols = columns_for(columns, len(all_quotes), width)
    page_size = PAGE_2COL if cols == 2 else PAGE_1COL
    quotes = all_quotes[:page_size]
    page_count = max(1, math.ceil(len(all_quotes) / page_size))

    rows = [Row() for _ in range(TABLE_ROWS)]

    if cols == 2:
        halves = layout2(width)
        pct_right = halves[1]["pct_right"]
        head = rows[0]
        for lay in halves:
            head.put(lay["sym_col"], "代號", HEAD)
            head.put_right(lay["price_right"], "價格", HEAD)
            head.put_right(lay["pct_right"], "↓變更%", HEAD)
    else:
        lay = layout(width)
        pct_right = lay["pct_right"]
        head = rows[0]
        head.put(lay["sym_col"], "代號", HEAD)
        head.put_right(lay["price_right"], "價格", HEAD)
        head.put_right(lay["chg_right"], "變更$", HEAD)
        head.put_right(lay["pct_right"], "↓變更%", HEAD)

    page_tag = f" {1}/{page_count} " if page_count > 1 else ""
    rule_w = pct_right - 1 - disp_width(page_tag)
    rows[1].put(1, "─" * rule_w, (0x2D, 0x33, 0x3B))
    if page_tag:
        rows[1].put(rows[1].width(), page_tag, DIM)

    dim = phase != "open"

    def draw_quote(r, lay, q, with_chg):
        sym = q["sym"]
        r.put(lay["sym_col"], sym["code"], DIM if dim else SYMBOL)
        if lay["show_name"]:
            r.put(lay["name_col"], sym["name"], DIM)
        color = GRAY if dim else tone(market, q["pct"])
        r.put_right(lay["price_right"], thousands(q["price"], conf["decimals"]), WHITE if not dim else GRAY)
        if with_chg:
            r.put_right(lay["chg_right"], signed(q["change"]), color)
        r.put_right(lay["pct_right"], pct_text(q["pct"]), color)

    if cols == 2:
        half = PAGE_2COL // 2
        for i in range(half):
            r = rows[2 + i]
            if i < len(quotes):
                draw_quote(r, halves[0], quotes[i], with_chg=False)
            if half + i < len(quotes):
                draw_quote(r, halves[1], quotes[half + i], with_chg=False)
    else:
        top_mover = max(range(len(quotes)), key=lambda i: abs(quotes[i]["pct"])) if quotes else 0
        for i, q in enumerate(quotes):
            r = rows[2 + i]
            draw_quote(r, lay, q, with_chg=True)
            if i == top_mover and phase == "open":
                r.fill_bg(ROW_HILIGHT, pct_right)

    # footer: index on the left (no parenthetical % - the pct column every
    # quote row already carries said it once), the clock/收盤 stamp, the live
    # dot and the source tag on the right
    foot = rows[7]
    ipct = conf["index_drift"] + conf["index_amp"] * math.sin(2 * math.pi * t / 89.0)
    ival = conf["index_close"] * (1 + ipct / 100.0)
    ichg = ival - conf["index_close"]
    icolor = GRAY if dim else tone(market, ichg)
    foot.put(1, conf["index_name"], DIM)
    foot.put(foot.width() + 1, thousands(ival), WHITE if phase == "open" else GRAY)
    foot.put(foot.width() + 1, ("▲ " if ichg > 0 else "▼ ") + signed(ichg), icolor)
    if phase == "open":
        stamp_core = clock_str(epoch_sec, market)
        dot_char = "●" if int(t * 2) % 2 == 0 else "○"
    else:
        close_min = SESSION_MINS[market][1]
        stamp_core = "收盤 %02d:%02d" % (close_min // 60, close_min % 60)
        dot_char = ""
    put_footer_tail(foot, pct_right, stamp_core, dot_char, "示範資料（未接 API）")

    return rows


# --- candle panel (--view chart) -------------------------------------------
# Two pixel rows per terminal row via half-block characters, exactly like the
# deploy band's Clawd sprite: a cell with both halves lit is "▀" with the top
# color as fg and the bottom color as bg.
CHART_PLOT_ROWS = 6  # -> 12 pixel rows of vertical resolution
AXIS_W = 10
BAR_STRIDE = 2  # one candle column + one gap column, so bodies stay distinct


def candle_cells(bars, market, plot_rows, prev_close, width):
    """-> plot_rows lists of cells, one candle every BAR_STRIDE columns."""
    if not bars:
        return [[] for _ in range(plot_rows)], 0.0, 0.0
    hi = max(b[1] for b in bars)
    lo = min(b[2] for b in bars)
    hi = max(hi, prev_close)
    lo = min(lo, prev_close)
    span = (hi - lo) or 1.0
    pix_rows = plot_rows * 2

    def to_pix(price):
        return int(round((hi - price) / span * (pix_rows - 1)))

    # pixel grid: None = empty, otherwise the color to light it with
    grid = [[None] * width for _ in range(pix_rows)]
    prev_pix = to_pix(prev_close)
    for c in range(width):
        # the previous close as a faint reference line, drawn under the candles
        grid[prev_pix][c] = (0x3A, 0x40, 0x4B)
    for i, (o, h, l, cl) in enumerate(bars):
        c = i * BAR_STRIDE
        if c >= width:
            break
        body = tone(market, cl - o) if cl != o else FLAT
        wick = tuple(max(0, v - 0x45) for v in body)
        for r in range(to_pix(h), to_pix(l) + 1):
            grid[r][c] = wick
        top, bot = to_pix(max(o, cl)), to_pix(min(o, cl))
        for r in range(top, bot + 1):
            grid[r][c] = body
    rows = []
    for j in range(plot_rows):
        cells = []
        for c in range(width):
            top_c, bot_c = grid[2 * j][c], grid[2 * j + 1][c]
            if top_c is None and bot_c is None:
                cells.append((" ", None, None))
            elif top_c is None:
                cells.append(("▄", bot_c, None))
            elif bot_c is None:
                cells.append(("▀", top_c, None))
            else:
                cells.append(("▀", top_c, bot_c))
        cells.append((" ", None, None))
        rows.append(cells)
    return rows, hi, lo


def render_chart(market, phase, t, width=BAND_WIDTH, epoch_sec=None, focus=0):
    """Same band as the table, one symbol's K bars instead - it keeps its own
    title row, since that line names the symbol rather than the market."""
    conf = MARKETS[market]
    lay = layout(width)
    epoch_sec = time.time() if epoch_sec is None else epoch_sec
    plot_w = max(10, lay["pct_right"] - 2 - AXIS_W)
    quotes = [quote_for(s, t, bars=plot_w // BAR_STRIDE) for s in conf["list"]]
    quotes.sort(key=lambda q: q["pct"], reverse=True)
    q = quotes[max(0, min(len(quotes) - 1, focus))]
    sym = q["sym"]
    rows = [Row() for _ in range(CHART_ROWS)]
    dim = phase != "open"
    color = GRAY if dim else tone(market, q["pct"])

    # row 0: which symbol, its price, the bar interval
    title = rows[0]
    title.put(lay["sym_col"], sym["code"], DIM if dim else SYMBOL)
    title.put(title.width() + 1, sym["name"], DIM)
    title.put(title.width() + 2, thousands(q["price"], conf["decimals"]), WHITE if not dim else GRAY)
    arrow = "▲" if q["pct"] > 0 else "▼" if q["pct"] < 0 else "-"
    title.put(title.width() + 1, f"{arrow} {signed(q['change'])} ({signed(q['pct'])}%)", color)
    state_txt = f"{'☀' if phase == 'open' else '☽'} {'盤中' if phase == 'open' else '休市'}"
    title.put_right(lay["pct_right"], f"K 棒（示範）· {conf['label']} {state_txt}", DIM)

    # rows 1..6: the candles, with a price axis on the right
    cells_by_row, hi, lo = candle_cells(q["bars"], market, CHART_PLOT_ROWS, sym["prev_close"], plot_w)
    for j in range(CHART_PLOT_ROWS):
        rows[1 + j].put_cells(lay["badge_col"], cells_by_row[j])
    rows[1].put_right(lay["pct_right"], thousands(hi, conf["decimals"]), DIM)
    rows[1 + CHART_PLOT_ROWS // 2].put_right(lay["pct_right"], thousands(sym["prev_close"], conf["decimals"]), (0x5A, 0x63, 0x70))
    rows[CHART_PLOT_ROWS].put_right(lay["pct_right"], thousands(lo, conf["decimals"]), DIM)

    # row 7: the session's time axis
    axis = rows[7]
    open_min, close_min = SESSION_MINS[market]
    mid_min = (open_min + close_min) // 2
    hm = lambda m: "%02d:%02d" % (m // 60, m % 60)
    rule = (0x2D, 0x33, 0x3B)
    axis.put(lay["badge_col"], hm(open_min), DIM)
    axis.put(axis.width(), "─" * max(1, plot_w // 2 - 7), rule)
    axis.put(axis.width(), hm(mid_min), DIM)
    axis.put(axis.width(), "─" * max(1, lay["badge_col"] + plot_w - 5 - axis.width()), rule)
    axis.put(axis.width(), hm(close_min), DIM)

    # row 8: where you are in the list, how to move (no hotkey: 趨勢圖 has
    # none, register.tsx dropped every Button hotkey on 2026-09-16), and the
    # data source
    foot = rows[8]
    foot.put(lay["sym_col"], f"{len(quotes)} 檔中第 {quotes.index(q) + 1} 檔", DIM)
    foot.put(foot.width() + 2, "趨勢圖換下一檔 / 回清單", DIM)
    tail = f"示範資料（未接 API） · {CREDIT}"
    if not foot.put_right_if_fits(lay["pct_right"], tail, DIM):
        foot.put_right_if_fits(lay["pct_right"], "示範資料（未接 API）", DIM)
    return rows


def control_row_text(market, phase, epoch_sec, page_count):
    """The dim row register.tsx draws above the Client: the market button on
    the left with the session state and hours, the remaining buttons
    right-aligned - no hotkeys on any of them (2026-09-16). This is drawn
    separately from the JSON/PNG band snapshot, which is the Client's own 8
    or 9 rows; the control row is a register.tsx concern, not board.tsx's."""
    conf = MARKETS[market]
    state = f"{'☀' if phase == 'open' else '☽'} {'盤中' if phase == 'open' else '休市'}"
    if phase == "open":
        left = f"{conf['label']} ▾  {state} {conf['hours']}"
    else:
        open_min = SESSION_MINS[market][0]
        left = f"{conf['label']} ▾  {state} 下次開盤 %02d:%02d" % (open_min // 60, open_min % 60)
    right_buttons = []
    if page_count > 1:
        right_buttons.append("翻頁 1/%d" % page_count)
    right_buttons.append("趨勢圖")
    right_buttons.append("收起 30分")
    right = "  ".join(f"[{b}]" for b in right_buttons)
    pad = max(1, BAND_WIDTH - disp_width(left) - disp_width(right))
    return left + " " * pad + right


def run_snapshot(spec, width, columns="auto"):
    market, phase = spec.split("-")
    view = "chart" if phase == "chart" else "table"
    if view == "chart":
        phase = "open"
    # a fixed t (and a fixed wall clock per market/phase) so the snapshot - and
    # the PNG preview built from it - is reproducible
    stamps = {"tw-open": 1757900000, "us-open": 1757946600,
              "tw-closed": 1757919600, "us-closed": 1757970000,
              "tw-chart": 1757900000, "us-chart": 1757946600}
    if view == "chart":
        rows = render_chart(market, phase, 12.0, width, epoch_sec=stamps[spec])
    else:
        rows = render(market, phase, 12.0, width, epoch_sec=stamps[spec], columns=columns)
    print(json.dumps([r.to_json() for r in rows], ensure_ascii=False))


def run_animation(market, phase, width, view="table", columns="auto"):
    sys.stdout.write(HIDE_CURSOR)
    band_rows = CHART_ROWS if view == "chart" else TABLE_ROWS
    total_rows = 1 + band_rows  # the control row register.tsx draws, plus the band
    for _ in range(total_rows):
        sys.stdout.write("\n")
    start = time.monotonic()
    try:
        while True:
            now = time.time()
            m, p = (market, phase) if market else pick_market(now)
            ph = p if phase is None else phase
            el = time.monotonic() - start
            if view == "chart":
                rows = render_chart(m, ph, el, width, now)
                page_count = 1
            else:
                rows = render(m, ph, el, width, now, columns=columns)
                page_count = max(1, math.ceil(len(MARKETS[m]["list"]) /
                                              (PAGE_2COL if columns_for(columns, len(MARKETS[m]["list"]), width) == 2 else PAGE_1COL)))
            sys.stdout.write(f"\x1b[{total_rows}A")
            control = Row()
            control.put(0, control_row_text(m, ph, now, page_count), DIM)
            sys.stdout.write("\r" + control.to_ansi() + "\x1b[K\n")
            for r in rows:
                sys.stdout.write("\r" + r.to_ansi() + "\x1b[K\n")
            sys.stdout.flush()
            time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(RESET + SHOW_CURSOR)
        sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", choices=["tw", "us"], default=None)
    ap.add_argument("--phase", choices=["open", "closed"], default=None)
    ap.add_argument("--width", type=int, default=BAND_WIDTH)
    ap.add_argument("--view", choices=["table", "chart"], default="table")
    ap.add_argument("--columns", choices=["auto", "1", "2"], default="auto",
                    help="表格欄數：auto=5 檔以下單欄、6 檔以上雙欄；1/2 強制指定")
    ap.add_argument("--snapshot", choices=["tw-open", "us-open", "tw-closed", "us-closed",
                                           "tw-chart", "us-chart"])
    args = ap.parse_args()
    columns = args.columns if args.columns == "auto" else int(args.columns)
    if args.snapshot:
        run_snapshot(args.snapshot, args.width, columns)
        return
    run_animation(args.market, args.phase, args.width, args.view, columns)


if __name__ == "__main__":
    main()
