// Render the real board.tsx against real props and print the 9 rows as text.
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , boardPath, regPath, cfgPath] = process.argv

// --- pull real props out of register.tsx -----------------------------------
const projDir = cfgPath
const handlers = new Map(); const timers = []
const $ = {
  clock: { now: async () => Date.now(), every: (ms, fn) => timers.push(fn) },
  // register.tsx reads two kinds of paths: project-relative overrides
  // (e.g. '.claude/stock-quotes.json', joined onto projDir below) and
  // absolute runtime-dir paths (e.g. `${home}/.claude/stock-band/<slug>/...`,
  // already rooted - joining projDir onto those would nest them under
  // projDir and always 404). An absolute `p` is read as-is.
  fs: { read: async p => readFile(p.startsWith('/') ? p : `${projDir}/${p}`).then(b => b.toString()) },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async (url, init) => { const r = await fetch(url, { headers: init?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
  env: { get: async name => (name === 'HOME' ? process.env.HOME : undefined) },
  session: { cwd: async () => projDir },
}
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))
const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
let props
const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of n.kids ?? []) walk(k, f) }
walk(tree, n => { if (n.type === 'Client') props = n.props.props })
const buttons = []
walk(tree, n => { if (n.type === 'Button') buttons.push(n.props.label) })

// --- render the board ------------------------------------------------------
const board = (await import(boardPath)).default
let state
const surface = {
  columns: 100,
  rows: 9,
  elements: { Box: 'Box', Text: 'Text' },
  get state() { return state },
  setState: s => { state = s },
  every: () => () => {},
  onPointer: () => {},
}
board(props, surface) // first call seeds state
const out = board(props, surface)

// flatten: the board returns a column Box whose children are the rows
function text(node, acc) {
  if (node == null || node === false) return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
  if (Array.isArray(node)) { for (const n of node) text(n, acc); return acc }
  const kids = [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]
  for (const k of kids) text(k, acc)
  return acc
}
console.log('buttons:', buttons.join('  '))
const rows = out.kids ?? []
for (const row of rows) console.log('|' + text(row, []).join('') + '|')
