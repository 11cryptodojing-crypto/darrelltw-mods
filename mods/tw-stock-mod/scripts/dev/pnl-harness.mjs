// Render the real board.tsx's pnl view against real props and print the 8
// rows as text. Same stub host as board-harness.mjs, plus one extra step:
// press the 損益 button (found in the first render's tree) before rendering,
// so the module's own `view` state flips to 'pnl' the same way a real click
// would, instead of poking at register.tsx's private state directly.
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , boardPath, regPath, cfgPath, pluginRoot, colsArg] = process.argv
const COLS = colsArg ? Number(colsArg) : 120

// --- pull real props out of register.tsx -----------------------------------
const projDir = cfgPath
const handlers = new Map()
const $ = {
  clock: { now: async () => Date.now(), every: () => {} },
  fs: { read: async p => readFile(new URL('file://' + projDir + '/' + p)).then(b => b.toString()) },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
  http: { fetch: async (url, init) => { const r = await fetch(url, { headers: init?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
  session: { cwd: async () => projDir },
  env: { get: async () => undefined },
  process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  plugin: { root: pluginRoot ?? '' },
}
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of n.kids ?? []) walk(k, f) }

async function render() {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: COLS } }, async () => ({ kids: [] }))
  let props
  const buttons = []
  walk(tree, n => {
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button') buttons.push(n)
  })
  return { tree, props, buttons }
}

const first = await render()
const pnlButton = first.buttons.find(b => b.props.label === '損益')
if (!pnlButton) {
  console.error('no 損益 button in the first render - buttons were:', first.buttons.map(b => b.props.label))
  process.exit(1)
}
pnlButton.props.onPress()
const second = await render()
console.log('buttons (pnl view):', second.buttons.map(b => b.props.label).join('  '))

// --- render the board's pnl view --------------------------------------------
const board = (await import(boardPath)).default
let state
const surface = {
  columns: COLS,
  rows: 8,
  elements: { Box: 'Box', Text: 'Text' },
  get state() { return state },
  setState: s => { state = s },
  every: () => () => {},
  onPointer: () => {},
}
board(second.props, surface) // first call seeds state
const out = board(second.props, surface)

function text(node, acc) {
  if (node == null || node === false) return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
  if (Array.isArray(node)) { for (const n of node) text(n, acc); return acc }
  const kids = [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]
  for (const k of kids) text(k, acc)
  return acc
}
const rows = out.kids ?? []
for (const row of rows) console.log('|' + text(row, []).join('') + '|')
