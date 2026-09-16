// Watch the real pnl board animate over real time - same pattern as
// frames.mjs (real timers, real wall clock, no surface.every stub needed
// since the flap position is a pure function of Date.now()), except it
// first walks the market button to the pnl stop, then watches the mount
// flap settle.
//
// Usage: node pnl-frames.mjs <board.js> <register.js> <projectDir> [seconds]
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , boardPath, regPath, projDir, seconds] = process.argv
const RUN_MS = Number(seconds ?? 3) * 1000

const handlers = new Map()
const $ = {
  clock: { now: async () => Date.now(), every: (ms, fn) => setInterval(fn, ms) },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: m => console.log('LOG', m), invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
  http: { fetch: async (url, init) => { const r = await fetch(url, { headers: init?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
  session: { cwd: async () => projDir },
  env: { get: async () => undefined },
  process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  plugin: { root: projDir + '/../mods/tw-stock-mod' },
}
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of n.kids ?? []) walk(k, f) }
async function render() {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 120 } }, async () => ({ kids: [] }))
  let props
  const buttons = []
  walk(tree, n => {
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button') buttons.push(n)
  })
  return { props, buttons }
}

const board = (await import(boardPath)).default
let state
const surface = {
  columns: 120, rows: 8,
  elements: { Box: 'Box', Text: 'Text' },
  get state() { return state },
  setState: s => { state = s },
  every: () => () => {},
  onPointer: () => {},
}

// The Client stays mounted across a view switch (register.tsx never changes
// its `key`), so `surface.state` carries a real prior `turn` into the pnl
// mount in the actual session - board.tsx's own seed logic treats state
// already matching the current turn as "not an update" (no flap-in on a
// genuinely fresh mount). Rendering the TABLE view once first, before
// walking to pnl, reproduces that real prior state instead of a harness
// artifact where pnl would be the very first thing this surface ever saw.
let cur = await render()
board(cur.props, surface)

// walk the market button to the pnl stop, same as pnl-harness.mjs
let presses = 0
while (cur.props?.view !== 'pnl' && presses < 6) {
  const marketButton = cur.buttons.find(b => b.props.label?.endsWith('▾'))
  if (!marketButton) { console.error('no market button found'); process.exit(1) }
  marketButton.props.onPress()
  presses += 1
  cur = await render()
}
console.log(`market button pressed ${presses}x -> view=${cur.props?.view}, mount should now be flapping in`)
const text = (n, acc = []) => {
  if (n == null || n === false) return acc
  if (typeof n === 'string' || typeof n === 'number') { acc.push(String(n)); return acc }
  if (Array.isArray(n)) { for (const k of n) text(k, acc); return acc }
  const kids = [...(n.kids ?? []), ...(n.props?.children != null ? [n.props.children] : [])]
  for (const k of kids) text(k, acc)
  return acc
}

const t0 = Date.now()
let lastRow = ''
let frames = 0
let printed = 0
while (Date.now() - t0 < RUN_MS) {
  const { props } = await render()
  const out = board(props, surface)
  frames++
  const rows = (out.kids ?? []).map(r => text(r).join(''))
  const dataRows = rows.slice(2, 7) // title, header, 5 data rows, totals
  const body = dataRows.join('\n')
  if (body !== lastRow) {
    const ms = String(Date.now() - t0).padStart(6)
    const flags = (props.holdings ?? [])
      .slice(props.holdingsScroll, props.holdingsScroll + 5)
      .map(h => (h.was ? (h.was.code !== undefined ? 'P' : 'p') : '.'))
      .join('')
    console.log(`--- ${ms}ms turn=${props.turn} was=${flags}`)
    for (const r of dataRows) console.log('   |' + r + '|')
    lastRow = body
    printed++
  }
  await new Promise(r => setTimeout(r, 50))
}
console.log(`\n${frames} renders, ${printed} distinct frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
process.exit(0)
