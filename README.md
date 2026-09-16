# darrelltw-mods

Claude Code mods I build for myself and then clean up enough to share. They all
draw into the strip above the prompt (`AbovePrompt`), they all run on
**function hooks** (early access), and none of them spend model tokens —
nothing here calls `$.model.*` or touches your prompt.

## What's in here

| mod | what it does |
| --- | --- |
| [`tw-stock-mod`](mods/tw-stock-mod/README.md) | 台股／美股看板。台股時段顯示台股清單（紅漲綠跌），美股時段顯示美股清單（綠漲紅跌），券商風格表格＋Solari 翻牌指數列。台美各 20 檔，報價走 Yahoo，免金鑰 |

More will land here. The marketplace is named after me rather than after what
is in it, so adding an unrelated mod later does not make the name a lie.

## Install

1. Turn function hooks on in `~/.claude/settings.json` (merge the `env` key if
   you already have one):

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
   ```

2. Add this marketplace and install the mod you want:

   ```sh
   claude plugin marketplace add darrell-tw/darrelltw-mods
   claude plugin install tw-stock-mod@darrelltw-mods
   ```

3. Restart Claude Code.

Each mod's own README covers its config file, and the stock mod ships a
`/stock-band-setup` command that writes one for you.

To remove:

```sh
claude plugin uninstall tw-stock-mod
claude plugin marketplace remove darrelltw-mods
```

## Requirements

- **Claude Code 2.1.269 or later.** Drawing above the prompt does not exist
  before that.
- **`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.** Function hooks are early access;
  without the flag Claude Code ignores the `modules` key and nothing loads.
- **An interactive terminal.** `AbovePrompt` is terminal-only — nothing draws
  in `claude -p`, the desktop app, or mobile.

## Repo layout

```
.claude-plugin/marketplace.json   makes this repo installable as a marketplace
docs/api-notes.md                 function-hooks API facts every mod here relies on, with sources
mods/<name>/                      one mod per folder, each its own plugin
  .claude-plugin/plugin.json      that mod's manifest
  hooks/                          its hooks module and Client board
  README.md                       its own docs
```

Adding a mod means dropping a folder under `mods/` and adding one entry to
`.claude-plugin/marketplace.json`. The repo root is only ever the marketplace,
never a plugin itself.

## Develop

```sh
# type-check a mod (needs the early-access types: run /plugin-types in a Claude
# Code session opened in this repo first)
bunx -p typescript tsc -p mods/tw-stock-mod

# lint
bunx --bun oxlint@1.83.0 mods/tw-stock-mod/hooks --deny-warnings

# validate the marketplace manifest
claude plugin validate .
```

Never name a local variable `h` in any `hooks/*.tsx` file — every JSX tag in
those files compiles to a call of `h`.

## Author

**Darrell Wang** — 自由接案，做 Martech / AI / 自動化（GA4、GTM、n8n），寫
自媒體，也開課教 Vibe Coding。這些 mod 是自己每天在用的東西，順手整理出來。

- X: [@darrell_tw_](https://x.com/darrell_tw_)
- GitHub: [@darrell-tw](https://github.com/darrell-tw)
- Email: info@darrelltw.com

Issues and PRs welcome.

## License

[MIT](LICENSE). Use it, change it, ship it in something you sell — just keep
the copyright notice.
