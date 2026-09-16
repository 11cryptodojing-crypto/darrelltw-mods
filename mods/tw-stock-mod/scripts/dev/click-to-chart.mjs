// 點表格裡的一列 → 該檔的趨勢圖。走完整條路：board 的 onPointer 命中測試 →
// surface.post → register 的 ui.message → 下一次 ui.render 的 view / focus。
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , boardPath, regPath, projDir, colsArg] = process.argv
const COLS = Number(colsArg || 120)

const handlers = new Map()
const $ = {
  clock: { now: async () => Date.now(), every: () => {} },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async (u, i) => { const r = await fetch(u, { headers: i?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
}
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))
await new Promise(r => setTimeout(r, 2500)) // let the feed answer

const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of [...(n.kids ?? []), n.props?.children]) walk(k, f) }
const draw = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: COLS } }, async () => ({ kids: [] }))
  let props; const btns = []
  walk(tree, n => { if (n.type === 'Client') props = n.props.props; if (n.type === 'Button') btns.push(n.props.label) })
  return { props, btns }
}

// the board's own surface, with the pointer listener captured
const board = (await import(boardPath)).default
let state, onPointer, posted
const surface = {
  columns: COLS, rows: 9,
  elements: { Box: 'Box', Text: 'Text' },
  get state() { return state }, setState: s => { state = s },
  every: () => () => {},
  onPointer: fn => { onPointer = fn; return () => { onPointer = undefined } },
  onKey: () => () => {},
  post: data => { posted = data },
}
const rowText = out => (out.kids ?? []).map(row => {
  const acc = []; const t = n => { if (n == null || n === false) return
    if (typeof n === 'string' || typeof n === 'number') { acc.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(t); return }
    for (const k of [...(n.kids ?? []), ...(n.props?.children != null ? [n.props.children] : [])]) t(k) }
  t(row); return acc.join('')
})

const click = async (x, y) => {
  const { props } = await draw()
  board(props, surface)              // seed
  const out = board(props, surface)  // real render writes the hit map
  posted = undefined
  onPointer?.({ type: 'down', x, y, button: 'left' })
  const rows = rowText(out)
  if (posted !== undefined) await handlers.get('ui.message')($, { surface: 'terminal', component: 'AbovePrompt', requestId: 'r', element: 'stock-band:table', module: './board.tsx', data: posted }, async () => ({}))
  const after = await draw()
  const sym = after.props.view === 'chart' ? after.props.quotes[after.props.focus]?.code : '—'
  console.log(`點 (x=${String(x).padStart(3)}, y=${y})  該列畫的是：${(rows[y] ?? '').trim().slice(0, 92).padEnd(92)} post=${JSON.stringify(posted) ?? 'none'}  →  view=${after.props.view} 焦點=${sym}`)
  return after
}

const back = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: COLS } }, async () => ({ kids: [] }))
  let press; walk(tree, n => { if (n.type === 'Button' && n.props.label === '回清單') press = n.props.onPress })
  press?.()
}

const first = await draw()
console.log(`欄寬 ${COLS}，${first.props.columns === 2 ? '兩欄' : '單欄'}，本頁 ${first.props.quotes.length} 檔：${first.props.quotes.map(q => q.code).join(' ')}`)
await click(2, 0);  await back()   // 表頭，不該有反應
await click(2, 2);  await back()   // 第 1 列
await click(2, 4);  await back()   // 第 3 列
await click(COLS - 10, 3); await back() // 右半第 2 列（兩欄時）
await click(2, 7);  await back()   // 指數列，不該有反應
await click(2, 4)                  // 進圖表後再點一次：圖表沒有列可點
await click(2, 3)
process.exit(0)
