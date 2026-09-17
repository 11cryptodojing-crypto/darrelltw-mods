// Does a quotes-file source (永豐/證交所, no bars of its own) get K bars from
// Yahoo the same way the built-in live feed does? Switches to the chart view,
// waits for feedBars' async fetch, and prints whether a Yahoo chart request
// fired and whether the board draws bars instead of "沒有 K 棒資料".
// Usage: node file-bars.mjs <register.js> <board.js> <projDir>
import { readFile, writeFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, boardPath, projDir] = process.argv

// Stamp the quotes file with `asOf: now` right before the run: QUOTE_STALE_MS
// is only 120s, so a fixture written even a couple of tool calls earlier can
// go stale before this script gets to read it.
{
  const quotesPath = `${projDir}/.claude/stock-quotes.json`
  const raw = JSON.parse(await readFile(quotesPath, 'utf8'))
  raw.asOf = Date.now()
  await writeFile(quotesPath, JSON.stringify(raw, null, 2))
}

const logs = []
const $ = {
  clock: { now: async () => Date.now(), every: () => {} },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: m => logs.push(m), invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: {
    fetch: async (u, i) => {
      const r = await fetch(u, { headers: i?.headers })
      const text = await r.text()
      logs.push(`FETCH ${r.status} ${u.slice(0, 100)}`)
      return { ok: r.ok, status: r.status, text }
    },
  },
  env: { get: async name => (name === 'HOME' ? process.env.HOME : undefined) },
  session: { cwd: async () => projDir },
}
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of [...(n.kids ?? []), n.props?.children]) walk(k, f) }
const draw = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
  let props; const btns = []
  walk(tree, n => { if (n.type === 'Client') props = n.props.props; if (n.type === 'Button') btns.push({ label: n.props.label, press: n.props.onPress }) })
  return { props, btns }
}

const board = (await import(boardPath)).default
const boardText = props => {
  let state
  const surface = {
    columns: 100, rows: 9,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  const out = board(props, surface)
  const text = (node, acc) => {
    if (node == null || node === false) return acc
    if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
    if (Array.isArray(node)) { for (const n of node) text(n, acc); return acc }
    for (const k of [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]) text(k, acc)
    return acc
  }
  return (out.kids ?? []).map(row => text(row, []).join(''))
}

let { props, btns } = await draw()
console.log(`起始  view=${props.view} source=${props.source}`)
btns.find(b => b.label === '趨勢圖')?.press()
;({ props, btns } = await draw())
console.log(`切圖表 view=${props.view} source=${props.source} focus=${props.quotes[props.focus]?.code} bars=${props.quotes[props.focus]?.bars?.length ?? 0}`)
console.log('板面（無 bars 時應見「沒有 K 棒資料」）：')
for (const line of boardText(props)) console.log('|' + line + '|')

console.log('\n等待 feedBars 的非同步 fetch 落地...')
await new Promise(r => setTimeout(r, 3000))

;({ props } = await draw())
console.log(`\n重繪 view=${props.view} source=${props.source} focus=${props.quotes[props.focus]?.code} bars=${props.quotes[props.focus]?.bars?.length ?? 0} barLabel=${props.barLabel}`)
console.log('板面（應見 K 棒，不再是「沒有 K 棒資料」）：')
for (const line of boardText(props)) console.log('|' + line + '|')

console.log('\n--- http/log ---')
for (const l of logs) console.log(l)
process.exit(0)
