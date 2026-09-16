// Watch the real board animate over real time: run the hooks module with the
// real config, let its timers fire on their own intervals, and print every
// frame in which the first quote row changes.
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , boardPath, regPath, projDir, seconds] = process.argv
const RUN_MS = Number(seconds ?? 15) * 1000

const handlers = new Map()
const $ = {
  clock: { now: async () => Date.now(), every: (ms, fn) => setInterval(fn, ms) },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: m => console.log('LOG', m), invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async (url, init) => { const r = await fetch(url, { headers: init?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
}
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

const board = (await import(boardPath)).default
let state
const surface = {
  columns: 100, rows: 9,
  elements: { Box: 'Box', Text: 'Text' },
  get state() { return state },
  setState: s => { state = s },
  every: () => () => {},
}
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
while (Date.now() - t0 < RUN_MS) {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
  let props
  const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of n.kids ?? []) walk(k, f) }
  walk(tree, n => { if (n.type === 'Client') props = n.props.props })
  const out = board(props, surface)
  frames++
  const rows = (out.kids ?? []).map(r => text(r).join(''))
  // The table view lost its title row when the market control moved up into
  // the hook tree's own row, so the quotes start at index 2: header, rule,
  // then five quotes. The chart view still opens with a title, so it keeps
  // the older offset.
  const first = props.view === 'chart' ? 3 : 2
  const quoteRows = rows.slice(first, first + 5)
  const body = quoteRows.join('\n')
  if (body !== lastRow) {
    const ms = String(Date.now() - t0).padStart(6)
    const flags = props.quotes.map(q => (q.was ? (q.was.code !== undefined ? 'P' : 'p') : '.')).join('')
    console.log(`--- ${ms}ms turn=${props.turn} seq=${props.seq} page=${props.page + 1}/${props.pageCount} was=${flags}`)
    for (const r of quoteRows) console.log('   |' + r.slice(0, 104) + '|')
    lastRow = body
  }
  await new Promise(r => setTimeout(r, 50))
}
console.log(`\n${frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
process.exit(0)
