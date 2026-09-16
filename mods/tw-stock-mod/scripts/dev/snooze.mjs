// Press 收起 30分 then bring the band back: does the board get a frame clock again?
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
const [, , boardPath, regPath, projDir] = process.argv
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
const board = (await import(boardPath)).default

const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of n.kids ?? []) walk(k, f) }
const draw = () => handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))

let installs = 0
let instance = 0
let live // the mounted surface, or undefined while unmounted
function mount() {
  instance++
  const id = instance
  let state
  return {
    columns: 100, rows: 9, elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: ms => { installs++; console.log(`   instance ${id}: surface.every(${ms}) installed`); return () => {} },
  }
}

// one host frame: render the hooks tree, mount/unmount the Client to match it
async function frame(label) {
  const tree = await draw()
  let clientProps
  const buttons = {}
  walk(tree, n => {
    if (n.type === 'Client') clientProps = n.props.props
    if (n.type === 'Button') buttons[n.props.key] = n.props.onPress
  })
  if (clientProps && !live) { live = mount() }          // the host mounts it
  if (!clientProps && live) { live = undefined; console.log(`   (Client unmounted)`) } // ...and drops it
  if (clientProps && live) board(clientProps, live)
  console.log(`${label}: Client ${clientProps ? 'drawn' : 'absent'}`)
  return buttons
}

let b = await frame('1. normal')
await frame('2. normal again')
b['stock-band:snooze']()      // press 收起 30分
b = await frame('3. after 收起 30分')
b['stock-band:wake']()        // press it back
await frame('4. after bringing it back')
await frame('5. and again')
console.log(`\ntotal frame clocks installed: ${installs} across ${instance} instances`)
console.log(installs === instance ? 'OK' : `BUG: ${instance - installs} instance(s) animate with no frame clock`)
