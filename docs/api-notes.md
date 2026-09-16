# Function-hooks API notes (verified sources only)

Sources: `cc-arcade-ref` (github.com/sezaakgun/cc-arcade, cloned `--depth 1`) and
`claude-code.d.ts` from `anthropics/claude-code` repo, `mods/types/claude-code.d.ts`
(fetched via `gh api`, saved to scratchpad, line numbers below refer to that fetch).

## Plugin layout (cc-arcade-ref)
- `.claude-plugin/plugin.json`: `name, version, description, author{name}, homepage, repository, license, keywords`.
- `hooks/hooks.json`: `{ "description": "...", "modules": ["./register.tsx"] }` — module path is a string literal, relative to `hooks/`.
- `hooks/register.tsx`: `export const register: Register = on => { ... }`. `Register = (on: On, options: PluginOptions) => unknown` (d.ts:5880).
- Board files are separate `Client` surface modules loaded by `module` string literal only — no variables (d.ts ClientProps.module comment, ~line 1013): "a variable there is refused at load, as is a path outside the plugin".
- Rule (README "Develop", common.tsx comment): never name a local variable `h` in any `/* @jsx h */` file — every JSX tag compiles to `h(...)`.

## `on(pattern, [matcher], hook)` (register.tsx)
- `on('session.start', async ($, e, next) => { const r = await next(e); ...; return r })` — `e.cwd`, `e.surface`, `e.isInteractive` (d.ts:7302).
- `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {...})`. Guard `e.props.hasSurvey` and `e.surface !== 'terminal'` before drawing (register.tsx ~line 197; AbovePrompt props at d.ts:6524: `hasSurvey, isWorking, maxRows, bodyColumns, scroll, view`, all read-only).
- `e.viewport?.columns` (d.ts:6223/6787, `RenderViewport`, optional, "absent where no surface has measured").
- `const { Box, Button, Client, Text } = await $.ui.resolve(e)` (register.tsx line ~196; d.ts confirms `'ui.resolve': ResolveInput` / returns `ElementTable`).
- `Button.hotkey` (d.ts:653-658): one digit or one lowercase letter. A digit presses from an empty composer; a digit *or* letter presses on keydown only while one of the band's Buttons already holds the focus ring. Consequence for a band: a letter hotkey buys nothing over plain Enter once the ring is on a Button, and a digit hotkey fires from an empty composer and eats a prompt that starts with that digit — cc-stock-band (2026-09-16) dropped every `hotkey` prop for this reason and left its buttons click- or focus+Enter-only.
- `<Client key="..." module="./boards/x.tsx" width={cols} height={rows} props={...} />` — props must be `JsonValue`.
- `on('turn.complete', async ($, e, next) => { const r = await next(e); ...; return r })` — used as a passthrough hook.
- `$.ui.invalidate('ui.render')` triggers a re-render (d.ts:1849, `InvalidatableEventName` includes `RenderEventName`, d.ts:3782).
- `$.ui.log(text)` for diagnostics on caught errors (register.tsx pattern, used throughout for store/fs failures).

## Clock and fs (`$`, hooks module only — NOT available inside a Client board)
- `$.clock.now(): Promise<number>` (d.ts:2517-2522) — **must be awaited**; cc-arcade-ref's `register.tsx` calls it unawaited in a couple of spots (e.g. `turnStartedAt = $.clock.now()`), which is a latent bug in that repo (never `tsc`-checked in CI — the README says type-checking needs `/plugin-types` run interactively, and CI only runs `bun test` + `oxlint`). This mod always awaits it.
- `$.clock.every(ms, fn): Timer` (d.ts:2540-2547) — dispatched as an event per period; `fn` may be async (fire-and-forget). Used here for a 500ms poll of the progress file.
- `$.fs.read(path): Promise<string>` — relative paths resolve against the session's cwd, rejects (`ENOENT`) if missing (d.ts:2426-2433, 4617-4622). We read `.claude/deploy-progress.json` (relative), wrapped in try/catch.

## Client board module (`hooks/board.tsx`)
- Signature: `ClientModule<P, S> = (props: P, surface: ClientSurface<S>) => RenderElement` (d.ts:966).
- `surface.elements` = `Box/Text/...` (no `Client`, no `Raster`) — d.ts:938.
- `surface.state` / `surface.setState(next)`: local state kept across redraws; start `surface.every(ms, fn)` only once, guarded by `if (surface.state === undefined)` (pattern from `hooks/boards/pet.tsx`).
- `surface.every(ms, fn): () => void` runs on the surface's own frame clock, independent of the hooks module — this is where all our animation ticks (150ms walk frame, 80ms track cursor, 500ms node pulse) live, so they only run while the `Client` is mounted (i.e. while the band is shown) and stop automatically when unmounted.
- The Client board has **no `$`**: it cannot call `$.clock.now()` itself. Wall-clock anchoring (`now`, `started`, `stepStarted`) is passed in via `props` from the hooks module (same pattern as `pet.tsx`'s `props={{ pet, now: $.clock.now() }}`), and the board extrapolates further ticks locally via its own frame counter — this is the standard pattern, not a workaround.

## Colors
- `TextProps.color?: string; backgroundColor?: string` — "Colors are a theme key or a raw color" (d.ts:7796-7809). Confirmed raw hex works: `hooks/boards/common.tsx`'s `Run` type carries `color?: string, bg?: string` and both are passed straight to `<Text color backgroundColor>`. **No conflict with the prototype's raw `#rrggbb` values** — no fallback needed.

## Install / validate (from README + local `claude plugin --help`)
- Function hooks flag: `~/.claude/settings.json` → `{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }`.
- Local hacking, no marketplace: `claude --plugin-dir <path>` (one session only).
- Persistent user-level install: `claude plugin marketplace add <local-path-or-repo>` then `claude plugin install <name>@<marketplace>`.
- `claude plugin validate <path>` validates a plugin or marketplace manifest (no interactive session needed).
- Real type-checking needs `/plugin-types` run inside an interactive session first (writes gitignored `.claude/types/`) — **not available to this non-interactive run**; flagged as unverified in the final report.
