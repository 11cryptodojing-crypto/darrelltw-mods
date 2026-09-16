// 假時鐘：時間由我推，這樣才驗得到「收盤後 10 分鐘」而不用真的等
import { readFile } from 'node:fs/promises'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir] = process.argv
let clock = Date.now()
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
const probe = async label => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
  let props; const walk = n => { if (!n || typeof n !== 'object') return
    if (n.type === 'Client') props = n.props.props
    for (const k of [...(n.kids ?? []), n.props?.children]) walk(k) }
  walk(tree)
  console.log(`${label.padEnd(26)} 累計請求=${String(fetches).padStart(3)}  來源=${String(props.source==='live'?props.sourceLabel:props.source).padEnd(12)} 倒數=${props.nextFeedAt ? '有' : '無'}`)
}
await new Promise(r => setTimeout(r, 2500))
await probe('開場（收盤中）')
const base = fetches
await tick(1); await probe('+1 分鐘')
await tick(5); await probe('+6 分鐘')
await tick(30); await probe('+36 分鐘')
await tick(120); await probe('+2 小時 36 分')
console.log(`\n開場之後又打了 ${fetches - base} 次請求（收盤中，應為 0）`)
process.exit(0)
