#!/usr/bin/env python3
"""
永豐 Shioaji -> <project>/.claude/stock-quotes.json (the band's override seam).

Why a script and not another branch of the feed: Shioaji is a Python SDK with
a login that takes seconds and holds a session, so it cannot be called from
the hooks module the way the exchange's and Yahoo's plain HTTP endpoints are.
This logs in once, writes the quotes file on a loop, and the band picks it up
- a fresh file wins over the built-in feed, and the footer says 永豐 即時.

What you need:
  * a 永豐金 account with the API enabled and 簽署中心 passed
  * SINOBON_API_KEY / SINOBON_SECRET_KEY in an env file (never in the repo)
  * shioaji installed on Python <= 3.13 (3.12 is what SinoPac tests against)

  ~/.venvs/shioaji/bin/python3 \
    mods/tw-stock-mod/scripts/fetch-quotes-shioaji.py \
    --env ~/.sinobon.env --project . --interval 10

Stop it with Ctrl-C. The band falls back to its own feed 120 seconds later.
"""
import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path

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


def snapshot_rows(api, contracts: dict) -> dict:
    """code -> {price, prevClose, name}. A symbol the snapshot skipped is left out."""
    if not contracts:
        return {}
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
            "name": getattr(contract, "name", None) or code,
            "ts": int(field(snap, "ts", 0) or 0),
        }
    return out


def build_payload(api, watchlist: list[dict], contracts: dict, index_contracts: list) -> dict | None:
    quotes = snapshot_rows(api, contracts)
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
        "quotes": {
            row["code"]: {
                "price": round(quotes[row["code"]]["price"], 4),
                "prevClose": round(quotes[row["code"]]["prevClose"], 4),
                "name": row["name"],
            }
            for row in watchlist
            if row["code"] in quotes
        },
    }
    if indices:
        payload["indices"] = indices
        payload["index"] = {k: v for k, v in indices[0].items() if k != "name"}
    return payload


def write_atomic(path: Path, payload: dict) -> None:
    """
    Write through a temp file and rename: the band polls this file every few
    seconds and a half-written JSON would read as malformed and drop it back
    to demo prices.
    """
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=os.getcwd(), help="the project whose .claude/ holds the band's files")
    parser.add_argument("--env", default="~/.sinobon.env", help="file holding SINOBON_API_KEY / SINOBON_SECRET_KEY")
    parser.add_argument("--interval", type=float, default=10, help="seconds between snapshots; 0 writes once and exits")
    parser.add_argument("--codes", default="", help="comma-separated codes, overriding the band's own watchlist")
    args = parser.parse_args()

    project = Path(args.project).expanduser().resolve()
    out_path = project / ".claude" / "stock-quotes.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if args.codes:
        watchlist = [{"code": c.strip(), "name": c.strip()} for c in args.codes.split(",") if c.strip()]
    else:
        watchlist = read_watchlist(project / ".claude" / "stock-band.json")
    if not watchlist:
        sys.exit(f"ERROR: 找不到台股清單（{project}/.claude/stock-band.json 的 `tw`），或用 --codes 指定")

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

    # Shioaji resolves 上市/上櫃 itself, so unlike the exchange endpoint the
    # watchlist needs no `ex` field here.
    contracts = {}
    for row in watchlist:
        contract = api.Contracts.Stocks[row["code"]]
        if contract is None:
            print(f"跳過 {row['code']}：永豐查不到這個代號", file=sys.stderr)
            continue
        contracts[row["code"]] = contract

    index_contracts = []
    for exchange, code, name in INDICES:
        contract = getattr(api.Contracts.Indexs, exchange)[code]
        if contract is not None:
            index_contracts.append((name, contract))

    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        while running:
            try:
                payload = build_payload(api, watchlist, contracts, index_contracts)
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
        print("永豐 已登出", file=sys.stderr)


if __name__ == "__main__":
    main()
