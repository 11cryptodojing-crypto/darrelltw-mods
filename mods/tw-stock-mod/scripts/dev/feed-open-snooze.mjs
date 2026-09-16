// 把假時鐘設到今天台北 10:30（週三、台股盤中），驗兩件事：
//   1) 盤中照打（別把省請求做成不打了）
//   2) 按下「收起 30分」之後不打
import { readFile } from 'node:fs/promises'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir] = process.argv
let clock = new Date('2026-09-16T10:30:00+08:00').getTime()
let fetches = 0
const timers = []
const $ = {
  clock: { now: async () => clock, every: (ms, fn) => timers.push({ ms, fn }) },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async (u, i) => { fetches++; const r = await fetch(u, { headers: i?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
}
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))
const tick = async mins => { clock += mins * 60_000; for (const t of timers) { await t.fn(); await new Promise(r => setTimeout(r, 400)) } }
const render = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
  const btns = []; let props
  const walk = n => { if (!n || typeof n !== 'object') return
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button') btns.push({ label: n.props.label, press: n.props.onPress })
    for (const k of [...(n.kids ?? []), n.props?.children]) walk(k) }
  walk(tree); return { btns, props } }
const probe = async l => { const { props } = await render()
  const where = props ? `盤別=${props.phase}  來源=${props.source==='live'?props.sourceLabel:props.source}` : '（收起中，板面沒畫）'
  console.log(`${l.padEnd(24)} 累計請求=${String(fetches).padStart(3)}  ${where}`) }
await new Promise(r => setTimeout(r, 2000))
await probe('台北 10:30 開場')
let a = fetches
await tick(1); await probe('+1 分鐘'); await tick(1); await probe('+2 分鐘')
console.log(`→ 盤中兩次 tick 打了 ${fetches - a} 次（應該 > 0）\n`)
const { btns } = await render()
btns.find(b => b.label === '收起 30分').press()
console.log('▼ 按下「收起 30分」')
a = fetches
await tick(1); await probe('收起後 +1 分鐘')
await tick(5); await probe('收起後 +6 分鐘')
console.log(`→ 收起期間打了 ${fetches - a} 次（應該 0）`)
process.exit(0)
