// 假時鐘：時間由我推，這樣才驗得到「收盤後 10 分鐘」而不用真的等。
// Anchored to a fixed closed-market instant instead of Date.now() so the
// assertions below hold no matter when this actually runs - see the `clock`
// comment.
import { readFile } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir] = process.argv
// 2026-09-17T14:00:00+08:00 (Thu) - 30 minutes after TW close (13:30), so
// phaseOf() reads "closed" from the very first tick without depending on
// when this script happens to be invoked in real life.
let clock = 1789624800000
let fetches = 0
const timers = []
const $ = {
  clock: { now: async () => clock, every: (ms, fn) => timers.push({ ms, fn }) },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async (u, i) => { fetches++; const r = await fetch(u, { headers: i?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
  env: { get: async name => (name === 'HOME' ? process.env.HOME : undefined) },
  session: { cwd: async () => projDir },
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
  return props
}

await new Promise(r => setTimeout(r, 2500))

let props = await probe('開場（收盤中）')
ok(props.source === 'live', '開場基準已經有一份 live 快照（不是 demo 示範資料）')
const base = fetches

await tick(1)
props = await probe('+1 分鐘')
ok(props.source === 'live', '+1 分鐘後快照仍有效（不是 demo）')

await tick(5)
props = await probe('+6 分鐘')
ok(props.source === 'live', '+6 分鐘後快照仍有效（不是 demo）')

await tick(30)
props = await probe('+36 分鐘')
ok(props.source === 'live', '+36 分鐘後快照仍有效（不是 demo）')

await tick(120)
props = await probe('+2 小時 36 分')
ok(props.source === 'live', '+2 小時 36 分後快照仍有效，沒有退回 demo')

console.log(`\n開場之後又打了 ${fetches - base} 次請求（收盤中，應為 0）`)
ok(fetches - base === 0, '收盤後的每個 tick 都沒有再發 $.http.fetch')

done()
