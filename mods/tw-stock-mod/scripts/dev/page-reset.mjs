// 驗「手動翻頁會不會把自動翻頁的倒數推後」。跑真的 register.tsx（編過的），
// 真的計時器，真的時間；只有 host 是假的。
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir, pressAtMs] = process.argv
const PRESS_AT = Number(pressAtMs)
const t0 = Date.now()
const el = () => Date.now() - t0
const $ = {
  clock: { now: async () => Date.now(), every: (ms, fn) => setInterval(fn, ms) },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async () => ({ ok: false, status: 0, text: '' }) },
}
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

const render = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
  let props, onPage
  const walk = n => { if (!n || typeof n !== 'object') return
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button' && String(n.props.label).includes('翻頁')) onPage = n.props.onPress
    for (const k of n.kids ?? []) walk(k) }
  walk(tree)
  return { props, onPage }
}

let last = null, pressed = false
const turns = []
while (el() < 26000) {
  const { props, onPage } = await render()
  if (props && props.page !== last) {
    const how = pressed && Math.abs(el() - PRESS_AT) < 300 ? '手動' : '自動'
    turns.push({ at: el(), page: props.page + 1, how })
    console.log(`${String(el()).padStart(6)}ms  →  第 ${props.page + 1} 頁   (${how})`)
    last = props.page
  }
  if (!pressed && el() >= PRESS_AT && onPage) {
    pressed = true
    console.log(`${String(el()).padStart(6)}ms  ▼ 使用者按下「翻頁」`)
    onPage()
  }
  await new Promise(r => setTimeout(r, 40))
}
const auto = turns.filter(t => t.how === '自動')
console.log('\n自動翻頁的間隔：', auto.map((t, i) => i ? t.at - auto[i-1].at : t.at).map(n => Math.round(n/100)/10 + 's').join('  '))
process.exit(0)
