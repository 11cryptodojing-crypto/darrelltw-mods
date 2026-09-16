#!/usr/bin/env python3
"""Render a colored PNG preview of the stock band by grabbing
stock-band-demo.py --snapshot frames and stacking them vertically.

Unlike render_png.py (macOS-only font paths) this one falls back to Linux
fonts, so it runs in a container as well as on a Mac.
"""

import json
import os
import subprocess
import sys
import unicodedata

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_PATH = os.path.join(SCRIPT_DIR, "stock-band-demo.py")
OUT_PATH = os.path.join(SCRIPT_DIR, "stock-band-preview.png")

MONO_CANDIDATES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
]
# Braille (U+28xx) is the one range the mono fonts above lie about: DejaVu Sans
# Mono reports a glyph and draws a .notdef box, which is exactly what a terminal
# whose font lacks braille will show. These are fonts that really draw the dots.
BRAILLE_CANDIDATES = [
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
CJK_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]

BG_COLOR = "#14161a"
FG_COLOR = "#d4d4d4"
LABEL_COLOR = "#8a8a92"

FONT_SIZE = 26
LABEL_SIZE = 16
MARGIN = 18

# (spec, columns, width, label). Width is per-frame since the two-column
# table wants more room than the single-column one, and one frame
# deliberately sits just under MIN_TWO_COL_WIDTH to show the fallback.
FRAMES = [
    ("tw-open", "2", 100, "台股盤中，20 檔預設清單：雙欄表格（columns: \"auto\" 一頁超過 5 檔）"),
    ("tw-open", "2", 76, "同一份清單在 76 欄：雙欄裝不下，退回單欄（門檻 77 欄）"),
    ("us-open", "1", 80, "美股盤中，5 檔預設清單：單欄表格（綠漲紅跌）"),
    ("tw-chart", "1", 90, "趨勢圖：按「趨勢圖」按鈕開單檔 K 棒，半格字元 12 像素"),
    ("tw-closed", "1", 80, "休市（價格轉灰、不閃燈）"),
]

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("pillow is required: pip3 install --user pillow")


def is_wide(ch):
    return unicodedata.east_asian_width(ch) in ("W", "F")


def load(candidates, size):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size, index=0)
        except OSError:
            continue
    raise OSError("no usable font among: " + ", ".join(candidates))


def get_snapshot(spec, columns, width):
    out = subprocess.run([sys.executable, DEMO_PATH, "--snapshot", spec,
                          "--width", str(width), "--columns", columns],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def main():
    mono = load(MONO_CANDIDATES, FONT_SIZE)
    cjk = load(CJK_CANDIDATES, FONT_SIZE)
    braille = load(BRAILLE_CANDIDATES, FONT_SIZE)
    label_font = load(CJK_CANDIDATES, LABEL_SIZE)

    cell_w = round(mono.getlength("0"))
    ascent, descent = mono.getmetrics()
    cell_h = ascent + descent + 6
    label_h = LABEL_SIZE + 10

    frames = [(label, width, get_snapshot(spec, columns, width)) for spec, columns, width, label in FRAMES]
    max_cols = max(width for _, width, _ in frames)
    img_w = MARGIN * 2 + max_cols * cell_w
    img_h = MARGIN * 2 + sum(label_h + len(rows) * cell_h for _, _, rows in frames) + (len(frames) - 1) * cell_h

    img = Image.new("RGB", (img_w, img_h), BG_COLOR)
    draw = ImageDraw.Draw(img)

    def pick(ch):
        if "\u2800" <= ch <= "\u28ff":
            return braille
        if is_wide(ch):
            return cjk
        if ch == " ":
            return mono
        return mono if mono.getmask(ch).getbbox() is not None else cjk

    y = MARGIN
    for idx, (label, width, rows) in enumerate(frames):
        draw.text((MARGIN, y), label, font=label_font, fill=LABEL_COLOR)
        y += label_h
        for row in rows:
            x = MARGIN
            for ch, fg, bg in row:
                w = cell_w * (2 if is_wide(ch) else 1)
                if bg:
                    draw.rectangle([x, y, x + w - 1, y + cell_h - 1], fill=bg)
                if ch != " ":
                    draw.text((x, y), ch, font=pick(ch), fill=fg or FG_COLOR)
                x += w
            y += cell_h
        if idx != len(frames) - 1:
            y += cell_h

    img.save(OUT_PATH)
    print(OUT_PATH)


if __name__ == "__main__":
    main()
