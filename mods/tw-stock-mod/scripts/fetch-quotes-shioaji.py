#!/usr/bin/env python3
"""
永豐 Shioaji -> <project>/.claude/stock-quotes.json and stock-holdings.json
(the band's override seams).

Why a script and not another branch of the feed: Shioaji is a Python SDK with
a login that takes seconds and holds a session, so it cannot be called from
the hooks module the way the exchange's and Yahoo's plain HTTP endpoints are.
This logs in once, writes both files on a loop, and the band picks them up -
a fresh quotes file wins over the built-in feed (footer says 永豐 即時), and the
holdings file feeds the 損益 view (source label 永豐 庫存).

Two ways to run it:
  * by hand, same as before - stop it with Ctrl-C, the band falls back to its
    own feed 120s later:

      ~/.venvs/shioaji/bin/python3 \
        mods/tw-stock-mod/scripts/fetch-quotes-shioaji.py \
        --env ~/.sinobon.env --project . --interval 10

  * spawned BY the band itself, when `stock-band.json` sets
    `"twSource": "shioaji"` (hooks/register.tsx's spawnShioaji). That path
    always passes `--heartbeat` and `--pidfile`:
      - `--heartbeat FILE`: the band rewrites this file's mtime-equivalent
        content on every tick it wants the Shioaji route. Once FILE is
        missing or its timestamp is more than 90s old, this process exits by
        itself - the band closed, or moved to the US board, and nothing is
        watching anymore.
      - `--pidfile FILE`: if FILE already holds another live process's pid,
        this run exits at once (0) rather than double-fetching for the same
        project; otherwise it writes its own pid there and removes it on the
        way out. Two Claude Code sessions on the same project then share one
        fetcher instead of racing two logins.

What you need:
  * a 永豐金 account with the API enabled and 簽署中心 passed
  * SINOBON_API_KEY / SINOBON_SECRET_KEY in an env file (never in the repo)
  * shioaji installed on Python <= 3.13 (3.12 is what SinoPac tests against)
"""
import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path

HEARTBEAT_MAX_AGE_MS = 90_000

# 發行量加權股價指數 / 櫃買指數. Latin names because the board flaps one
# character at a time and a Chinese character has no drum to riffle through.
INDICES = [
    ("TSE", "IX0001", "TAIEX"),
    ("OTC", "IX0043", "TPEx"),
]
# Shioaji stamps a snapshot with Taipei wall-clock time counted as if it were
# UTC, so a snapshot taken at 10:55 comes back as an epoch that reads 18:55.
# Measured 2026-09-16: ts was exactly 8 h ahead of the real clock. Taipei is
# UTC+8 all year, so one subtraction fixes it - and it has to be fixed here,
# because the band prints this as 更新.
TAIPEI_OFFSET_MS = 8 * 3600 * 1000


def load_env(path: Path) -> None:
    if not path.exists():
        sys.exit(f"ERROR: {path} 不存在（要有 SINOBON_API_KEY / SINOBON_SECRET_KEY）")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def read_watchlist(config_path: Path) -> list[dict]:
    """The band's own config is the list, so there is only ever one watchlist."""
    if not config_path.exists():
        return []
    try:
        root = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        sys.exit(f"ERROR: {config_path} 不是合法 JSON: {err}")
    rows = root.get("tw") if isinstance(root, dict) else None
    out = []
    for row in rows or []:
        code = str(row.get("code", "")).strip()
        if code:
            out.append({"code": code, "name": row.get("name") or code})
    return out


def field(obj, name, default=None):
    value = getattr(obj, name, default)
    return default if value is None else value


def resolve_name(code: str, contracts: dict, watchlist_names: dict) -> str:
    """
    Every quote and every holding names itself this way: the Shioaji contract
    first (`contract.name`, e.g. 台積電 - the one source that is always right
    when it has an answer), the watchlist's own name second (whatever
    `stock-band.json`'s `tw` entry or --codes said, which itself defaults to
    the code when nobody wrote a real name), and the code last. A code added
    to the fetch only because it showed up in `list_positions` - not on the
    watchlist at all - has no watchlist name to fall back to, so it depended
    entirely on the contract lookup; skipping this and naming a union row by
    its bare code (`00631L`, `2308`, even `2330`, which IS on the built-in
    list but was never in the SCRIPT's own copy of it before --codes existed)
    was the bug.
    """
    contract = contracts.get(code)
    cname = getattr(contract, "name", None) if contract else None
    return cname or watchlist_names.get(code) or code


def snapshot_rows(api, contracts: dict, watchlist_names: dict | None = None) -> dict:
    """code -> {price, prevClose, name}. A symbol the snapshot skipped is left out."""
    if not contracts:
        return {}
    watchlist_names = watchlist_names or {}
    snaps = api.snapshots(list(contracts.values()))
    out = {}
    for snap in snaps:
        code = str(field(snap, "code", ""))
        contract = contracts.get(code)
        close = float(field(snap, "close", 0) or 0)
        if not code or not contract or close <= 0:
            continue
        # `reference` is 昨收 (the 漲跌 basis the exchange publishes), and
        # change_price is what Shioaji itself computed against it - deriving
        # the basis back out keeps the two consistent when a symbol went ex-
        # dividend and the reference is not literally yesterday's close.
        change = float(field(snap, "change_price", 0) or 0)
        prev_close = float(field(contract, "reference", 0) or 0) or (close - change)
        out[code] = {
            "price": close,
            "prevClose": prev_close,
            "name": resolve_name(code, contracts, watchlist_names),
            "ts": int(field(snap, "ts", 0) or 0),
        }
    return out


def build_payload(api, contracts: dict, index_contracts: list, watchlist_names: dict) -> dict | None:
    quotes = snapshot_rows(api, contracts, watchlist_names)
    if not quotes:
        return None

    # the exchange's own clock, in ms: the band prints it as 更新, so it must
    # be when the prices traded and not when this script woke up
    traded_ns = max((row.pop("ts", 0) for row in quotes.values()), default=0)
    now_ms = int(time.time() * 1000)
    data_at = traded_ns // 1_000_000 - TAIPEI_OFFSET_MS if traded_ns else now_ms

    index_rows = snapshot_rows(api, {c.code: c for _, c in index_contracts})
    indices = []
    for name, contract in index_contracts:
        row = index_rows.get(contract.code)
        if not row:
            continue
        prev = row["prevClose"] or row["price"]
        indices.append(
            {
                "name": name,
                "value": round(row["price"], 2),
                "change": round(row["price"] - prev, 2),
                "pct": round((row["price"] - prev) / prev * 100, 2) if prev else 0,
            }
        )

    payload = {
        "asOf": now_ms,
        "dataAt": data_at,
        "market": "tw",
        "source": "永豐 即時",
        # every code the snapshot actually answered, not just the ones that
        # started out on the watchlist - `contracts` already IS the union
        # (watchlist UNION positions, kept current every tick in main()), so
        # this covers a position-only code the same as a watchlist one.
        "quotes": {
            code: {"price": round(row["price"], 4), "prevClose": round(row["prevClose"], 4), "name": row["name"]}
            for code, row in quotes.items()
        },
    }
    if indices:
        payload["indices"] = indices
        payload["index"] = {k: v for k, v in indices[0].items() if k != "name"}
    return payload


def build_holdings_payload(positions: list, contracts: dict, quotes: dict, watchlist_names: dict) -> dict | None:
    """
    `api.list_positions` -> the holdings file's shape (see
    references/quote-sources.md's 損益 section and stock-holdings.example.json).
    `price`/`prevClose` are filled here as a fallback only - the band prefers
    whatever the quotes file already says for that code (item 4/6 of the
    spec: the quotes fetch covers watchlist UNION positions precisely so
    every holding has a live price there too).
    """
    holdings = []
    for pos in positions:
        code = str(field(pos, "code", "")).strip()
        qty = float(field(pos, "quantity", 0) or 0)
        if not code or qty == 0:
            continue
        direction = str(field(pos, "direction", "Buy"))
        if "Sell" in direction:  # a short position - the qty sign carries it through the P&L math
            qty = -qty
        cost = float(field(pos, "price", 0) or 0)
        contract = contracts.get(code)
        name = resolve_name(code, contracts, watchlist_names)
        live = quotes.get(code)
        last_price = float(field(pos, "last_price", 0) or 0)
        price = live["price"] if live else (last_price or cost)
        prev_close = live["prevClose"] if live else (float(getattr(contract, "reference", 0) or 0) or price)
        holdings.append(
            {"code": code, "name": name, "qty": qty, "cost": round(cost, 4), "price": round(price, 4), "prevClose": round(prev_close, 4)}
        )
    if not holdings:
        return None
    return {"asOf": int(time.time() * 1000), "market": "tw", "source": "永豐 庫存", "holdings": holdings}


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def claim_pidfile(pidfile: Path) -> bool:
    """
    True: this process owns the pidfile and should run. False: another live
    process already owns it for this project, so the caller exits quietly
    (0) rather than double-fetching - see the module docstring's `--pidfile`
    section.
    """
    if pidfile.exists():
        try:
            existing = int(pidfile.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            existing = None
        if existing and existing != os.getpid() and pid_alive(existing):
            return False
    pidfile.parent.mkdir(parents=True, exist_ok=True)
    pidfile.write_text(str(os.getpid()), encoding="utf-8")
    return True


def heartbeat_stale(path: Path) -> bool:
    """Missing, unreadable, or older than HEARTBEAT_MAX_AGE_MS - all read as stale."""
    if not path.exists():
        return True
    try:
        ts = float(path.read_text(encoding="utf-8").strip())
    except (ValueError, OSError):
        return True
    return (time.time() * 1000 - ts) > HEARTBEAT_MAX_AGE_MS


def write_atomic(path: Path, payload: dict) -> None:
    """
    Write through a temp file and rename: the band polls this file every few
    seconds and a half-written JSON would read as malformed and drop it back
    to demo prices.
    """
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def fetch_positions(api) -> list:
    """`list_positions` in shares, not 張 - the band's Holding.qty contract wants shares."""
    import shioaji as sj

    return api.list_positions(api.stock_account, unit=sj.constant.Unit.Share) or []


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=os.getcwd(), help="the project whose .claude/ holds the band's files")
    parser.add_argument("--env", default="~/.sinobon.env", help="file holding SINOBON_API_KEY / SINOBON_SECRET_KEY")
    parser.add_argument("--interval", type=float, default=10, help="seconds between snapshots; 0 writes once and exits")
    parser.add_argument("--codes", default="", help="comma-separated codes, overriding the band's own watchlist")
    parser.add_argument("--heartbeat", default="", help="path the band keeps rewriting while it wants this route; missing or >90s old exits this process (empty disables the check, for a by-hand run)")
    parser.add_argument("--pidfile", default="", help="path holding this fetcher's pid; a live pid already there exits this run at once instead of double-fetching the same project")
    args = parser.parse_args()

    project = Path(args.project).expanduser().resolve()
    out_path = project / ".claude" / "stock-quotes.json"
    holdings_path = project / ".claude" / "stock-holdings.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    pidfile = Path(args.pidfile).expanduser().resolve() if args.pidfile else None
    if pidfile and not claim_pidfile(pidfile):
        print(f"另一個 fetcher 已經在跑這個專案（{pidfile} 裡的 pid 還活著），這次略過", file=sys.stderr)
        return
    heartbeat_path = Path(args.heartbeat).expanduser().resolve() if args.heartbeat else None

    if args.codes:
        watchlist = [{"code": c.strip(), "name": c.strip()} for c in args.codes.split(",") if c.strip()]
    else:
        watchlist = read_watchlist(project / ".claude" / "stock-band.json")

    load_env(Path(args.env).expanduser())
    for key in ("SINOBON_API_KEY", "SINOBON_SECRET_KEY"):
        if not os.environ.get(key):
            sys.exit(f"ERROR: {key} 沒設")

    import shioaji as sj  # imported here so --help works without the SDK

    api = sj.Shioaji()
    print("永豐 登入中…", file=sys.stderr)
    api.login(
        api_key=os.environ["SINOBON_API_KEY"],
        secret_key=os.environ["SINOBON_SECRET_KEY"],
        subscribe_trade=False,  # quotes only: this script never places an order
    )

    def stop(*_):
        nonlocal running
        running = False

    running = True
    try:
        positions = fetch_positions(api)
    except Exception as err:  # noqa: BLE001 - a failed first fetch just means no holdings this run
        print(f"庫存查詢失敗: {type(err).__name__}: {err}", file=sys.stderr)
        positions = []
    position_codes = {str(field(p, "code", "")).strip() for p in positions}
    position_codes.discard("")

    if not watchlist and not position_codes:
        sys.exit(
            f"ERROR: 找不到台股清單（{project}/.claude/stock-band.json 的 `tw`）也沒有庫存部位，"
            "或用 --codes 指定"
        )

    # Whatever name the watchlist itself carries for a code - resolve_name's
    # second choice, behind the Shioaji contract. --codes and a `tw` entry
    # with no explicit "name" both default to the code here, which is fine:
    # resolve_name still tries the contract first, so this only matters when
    # the contract lookup itself comes up empty.
    watchlist_names = {row["code"]: row["name"] for row in watchlist}

    # The quotes fetch covers the watchlist UNION every held code (item 4/6 of
    # the spec), so a holding that never made the watchlist still gets a live
    # price in stock-quotes.json - build_holdings_payload prefers exactly that
    # over the fallback price it computes itself.
    watchlist_codes = {row["code"] for row in watchlist}
    symbols = list(watchlist) + [{"code": c, "name": c} for c in position_codes if c not in watchlist_codes]

    # Shioaji resolves 上市/上櫃 itself, so unlike the exchange endpoint the
    # watchlist needs no `ex` field here.
    contracts: dict = {}

    def ensure_contract(code: str):
        if code in contracts:
            return contracts[code]
        contract = api.Contracts.Stocks[code]
        if contract is None:
            print(f"跳過 {code}：永豐查不到這個代號", file=sys.stderr)
            return None
        contracts[code] = contract
        return contract

    for row in symbols:
        ensure_contract(row["code"])

    index_contracts = []
    for exchange, code, name in INDICES:
        contract = getattr(api.Contracts.Indexs, exchange)[code]
        if contract is not None:
            index_contracts.append((name, contract))

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    first_tick = True
    try:
        while running:
            # Heartbeat check first, before doing any work this tick: a stale
            # heartbeat means nobody is watching Taiwan anymore (band closed,
            # or on the US board), and the very first tick is exempt because
            # the caller (spawnShioaji) writes the heartbeat moments BEFORE
            # spawning this process, not after.
            if heartbeat_path and not first_tick and heartbeat_stale(heartbeat_path):
                print(f"心跳逾時（{heartbeat_path} 沒人更新），結束", file=sys.stderr)
                break
            first_tick = False

            try:
                positions = fetch_positions(api)
            except Exception as err:  # noqa: BLE001 - keep the last good positions rather than crash
                print(f"庫存查詢失敗（保留上一份）: {type(err).__name__}: {err}", file=sys.stderr)
            for pos in positions:
                code = str(field(pos, "code", "")).strip()
                if code:
                    ensure_contract(code)
                    if code not in watchlist_codes and not any(s["code"] == code for s in symbols):
                        symbols.append({"code": code, "name": code})

            try:
                payload = build_payload(api, contracts, index_contracts, watchlist_names)
            except Exception as err:  # noqa: BLE001 - any SDK error is the same story here
                print(f"快照失敗（保留上一份檔案）: {type(err).__name__}: {err}", file=sys.stderr)
                payload = None
            if payload:
                write_atomic(out_path, payload)
                rows = len(payload["quotes"])
                stamp = time.strftime("%H:%M:%S", time.localtime(payload["dataAt"] / 1000))
                print(f"{stamp}  {rows} 檔 -> {out_path}", file=sys.stderr)
            # a failed snapshot leaves the file alone: the band drops a file
            # older than 120 s by itself and says so, which beats a stale price
            # that still looks live

            try:
                holdings_payload = build_holdings_payload(
                    positions, contracts, payload["quotes"] if payload else {}, watchlist_names
                )
            except Exception as err:  # noqa: BLE001 - same story as the quotes snapshot
                print(f"庫存快照失敗（保留上一份檔案）: {type(err).__name__}: {err}", file=sys.stderr)
                holdings_payload = None
            if holdings_payload:
                write_atomic(holdings_path, holdings_payload)
                print(f"{len(holdings_payload['holdings'])} 檔庫存 -> {holdings_path}", file=sys.stderr)

            if args.interval <= 0:
                break
            slept = 0.0
            while running and slept < args.interval:
                time.sleep(0.2)
                slept += 0.2
    finally:
        try:
            api.logout()
        except Exception:  # noqa: BLE001 - logout failing on the way out changes nothing
            pass
        if pidfile:
            try:
                pidfile.unlink(missing_ok=True)
            except OSError:
                pass
        print("永豐 已登出", file=sys.stderr)


if __name__ == "__main__":
    main()
