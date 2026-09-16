// 進圖表 → 按下一檔／上一檔 → 回清單，每一步把真的按鈕列與焦點印出來
import { readFile } from 'node:fs/promises'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir] = process.argv
const $ = {
  clock: { now: async () => Date.now(), every: () => {} },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async (u, i) => { const r = await fetch(u, { headers: i?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
}
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))
await new Promise(r => setTimeout(r, 2500))

const draw = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 120 } }, async () => ({ kids: [] }))
  const btns = [], texts = []; let props, side = 'left'
  const walk = (n, depth = 0) => { if (!n || typeof n !== 'object') return
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button') btns.push({ label: n.props.label, press: n.props.onPress, key: n.props.key })
    if (n.type === 'Text' && typeof n.props.children === 'string') texts.push(n.props.children)
    for (const k of [...(n.kids ?? []), n.props?.children]) walk(k, depth + 1) }
  walk(tree)
  return { btns, texts, props }
}
const show = async label => {
  const { btns, props } = await draw()
  const sym = props.view === 'chart' ? props.quotes[props.focus]?.code : '—'
  console.log(`${label.padEnd(14)} view=${String(props.view).padEnd(5)} 焦點=${sym}   按鈕列： ${btns.map(b => `[${b.label}]`).join(' ')}`)
  return btns
}
let b = await show('起始')
b.find(x => x.label === '趨勢圖').press(); b = await show('按 趨勢圖')
b.find(x => x.label.startsWith('下一檔')).press(); b = await show('按 下一檔')
b.find(x => x.label.startsWith('下一檔')).press(); b = await show('按 下一檔')
b.find(x => x.label === '◀ 上一檔').press(); b = await show('按 上一檔')
b.find(x => x.label === '◀ 上一檔').press(); b = await show('按 上一檔')
b.find(x => x.label === '◀ 上一檔').press(); b = await show('上一檔(繞回尾)')
b.find(x => x.label === '回清單').press(); await show('按 回清單')
process.exit(0)
