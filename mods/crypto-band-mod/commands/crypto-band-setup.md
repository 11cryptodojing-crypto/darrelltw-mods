---
description: 引導使用者設定 crypto-band-mod 的追蹤幣種清單
---

# 設定加密貨幣觀察清單

幫使用者設定 `<project>/.claude/crypto-band.json`。照下面的步驟做，第 2 步的驗證不能跳過。

## 0. 先確認環境

- 跑 `claude --version`，確認版號支援 function hooks（跟 crypto-band-mod 的 README 對一下最低版本）。
- 跑 `echo $CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`，要是 `1`。空白時才去讀 `~/.claude/settings.json`，
  把該合併進去的 JSON 片段印給使用者自己貼上——**不要代他寫檔**，並提醒他改完要完全關掉
  Claude Code 再開，`/reload-plugins` 不會重讀 env。
- 提醒一句「看板只在終端機畫得出來，`claude -p`、桌面版、手機版不會顯示」。

環境沒過就印出修法，問使用者「要現在先把清單設好，還是等環境修好再設」——不要沒問就默默往下做。

## 1. 檢查是否已有設定

先看 `<project>/.claude/crypto-band.json` 存不存在。

- 存在 → 讀出來，跟使用者說目前追蹤哪些幣，問他是要整份重寫還是只加減幾個。
- 不存在 → 問使用者要追蹤哪些幣（預設是 BTC/ETH/SOL/HYPE）。

crypto-band.json 的 `coins` 是 **CoinGecko 的 coin id**，不是交易所代號——`bitcoin` 不是
`BTC`，`binancecoin` 不是 `BNB`。使用者只會講代號很正常，你要幫他找出對應的 id。

## 2. 驗證每個 coin id 真的能查到報價——不要跳過

用 CoinGecko 的公開搜尋或清單 API 把使用者講的代號/幣名轉成 coin id，然後**用同一支
`coins/markets` 端點驗證一次**（這也是 band 本身在用的端點，見 `docs/crypto-api-notes.md`）：

```
https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=<逗號分隔的 coin id>&price_change_percentage=1h,24h
```

- 回傳陣列裡有這個 id 的物件、`current_price` 是數字 → 驗證通過，可以寫進設定檔。
- id 打錯、或 CoinGecko 沒有這個幣 → **明確跟使用者說是哪個查不到**，不要默默寫進檔案，也不要
  用交易所代號直接硬猜一個 id（`hype` 不是 `hyperliquid` 的 id，猜錯就是查不到報價的空行）。

一次最多 30 個 id（`MAX_COINS`，見 `hooks/register.tsx`），超過的部分會被截掉。

## 3. 寫入設定檔

- `.claude/` 資料夾不存在就先建起來。
- 如果 `crypto-band.json` 已經存在，**先把新舊內容的差異（diff）展示給使用者看，等他同意才覆蓋**。
- 把驗證過的 coin id 寫進 `coins` 陣列：`{ "id": "bitcoin" }` 就夠了。使用者想在畫面上顯示跟
  CoinGecko 不同的代號才需要加 `"symbol"`（例如 `{ "id": "bitcoin", "symbol": "BTC-PERP" }`）。

## 4. 提醒使用者重新載入

設定寫完後，提醒使用者跑一次 `/reload-plugins`。抓取頻率（`refreshMs`／`feedMs`）是 session
一開始就固定的，改了設定檔要重新載入 plugin 才會生效，單純等下一輪 poll 是吃不到新設定的。
