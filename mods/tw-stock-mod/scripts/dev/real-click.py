# 在 pty 裡開一個真的 Claude Code，等 band 畫出來，送真的 SGR 滑鼠點擊，再把畫面讀回來。
#
# 為什麼需要這個：stub host（scripts/dev/*.mjs）只證明模組自己的邏輯對，
# 證不了「引擎真的把事件送進來、我們的條件真的收得下」。2026-09-16 的 click-to-chart
# 就是這樣：stub host 全綠，真機完全沒反應，因為 ui.message 的 e.module 是
# `hooks/board.tsx`，不是 Client prop 寫的 `./board.tsx`。
#
# 用法：python3 real-click.py <專案目錄> [欄] [第幾列] [--plugin-dir <路徑>]
#   欄：0 = 左半（預設 8），大一點的數字（例如 70）打右半
import os, pty, select, time, sys, fcntl, termios, struct, re
import pyte  # pip install --user pyte

COLS, ROWS = 120, 42
CLAUDE = os.path.expanduser("~/.local/bin/claude")
args = sys.argv[1:]
plugin_dir = None
if "--plugin-dir" in args:
    i = args.index("--plugin-dir"); plugin_dir = args[i + 1]; del args[i:i + 2]
cwd = args[0] if args else os.getcwd()
click_x = int(args[1]) if len(args) > 1 else 8
which_row = int(args[2]) if len(args) > 2 else 0

env = dict(os.environ)
env["TERM"] = "xterm-256color"
env["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"] = "1"
env.pop("CLAUDECODE", None)
argv = [CLAUDE] + (["--plugin-dir", plugin_dir] if plugin_dir else [])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execve(CLAUDE, argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)

def pump(seconds):
    t0 = time.time()
    while time.time() - t0 < seconds:
        r, _, _ = select.select([fd], [], [], 0.3)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return
            if not data: return
            stream.feed(data)

def show(tag):
    print(f"===== {tag} =====")
    for i, line in enumerate(screen.display):
        if line.strip(): print(f"{i:3} |{line.rstrip()}")

pump(20)
show("開起來")
rows = [i for i, l in enumerate(screen.display)
        if re.match(r"\s*[A-Z0-9]{3,6}\s", l) and ("▲" in l or "▼" in l or "- 0.00" in l)]
if not rows:
    print("找不到報價列——band 沒畫出來？")
else:
    row = rows[min(which_row, len(rows) - 1)]
    print(f"點第 {which_row + 1} 條報價列（畫面第 {row} 列，x={click_x}）：{screen.display[row][:60]!r}")
    x, y = click_x, row + 1  # SGR 是 1-based
    os.write(fd, f"\x1b[<0;{x};{y}M".encode() + f"\x1b[<0;{x};{y}m".encode())
    pump(3)
    show("點下去之後")
os.write(fd, b"\x1b")
time.sleep(0.3)
try: os.kill(pid, 9)
except Exception: pass
