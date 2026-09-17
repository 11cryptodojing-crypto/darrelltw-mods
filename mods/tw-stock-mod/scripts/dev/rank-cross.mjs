// PR-a target: 表格畫面（board.tsx 的九列）在漲跌幅名次交叉時，代碼欄應該要
// 跟翻頁時一樣用 was.code/was.name 標出「這格剛換過人」，讓人看得出來剛剛坐
// 在這裡的是哪一檔。但 hooks/register.tsx 的 buildProps 只在真的翻頁
// （setPage 寫入 pageFrom）才會把 was 併進 shown[i]；純粹排序重排（sort 名次
// 對調、沒有 setPage）完全不會設 was - 代碼欄靜靜換人，翻牌動畫也不會播。
// 這裡讓兩檔漲跌幅名次對調（單頁清單，pageMs:0 關掉自動翻頁，排除任何巧合的
// 翻頁事件），斷言換位那一列出現 was.code。這條斷言現在預期是紅的。
//
// board-harness.mjs 的既有結構是單次、非時鐘驅動的 render，retrofit 成能在
// render 之間換報價、推時鐘、手動觸發 poll() 的 timer 不容易塞回去而不動它
// 原本的用途（印文字板給人看），所以另立這支：register.tsx 的 props 才是
// PR-a 的戰場（was 是 buildProps 算出來的），board.tsx 只是把它畫出來，這裡
// 兩者都做 - 印出 board 的文字板給人眼睛核對，斷言則直接讀 props，不去拆
// board.tsx 的翻牌動畫frame（那是時間軸換算，跟這個 bug 無關，見 README）。
//
// Usage: node rank-cross.mjs <board.js> <register.js> <projDir>
import { readFile, writeFile } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , boardPath, regPath, projDir] = process.argv

// 2026-09-17T10:00:00+08:00 (週四台股盤中) - 跟 chart-nav.mjs 用同一個錨點，
// 純粹圖個一致，數值本身對這支的斷言沒有特殊意義。
let clock = 1789596000000
const timers = []
const $ = {
  clock: { now: async () => clock, every: (ms, fn) => timers.push(fn) },
  fs: { read: async p => readFile(p.startsWith('/') ? p : `${projDir}/${p}`).then(b => b.toString()) },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async () => { throw new Error('rank-cross fixture runs feed:"off" - $.http.fetch should never be called') } },
  env: { get: async name => (name === 'HOME' ? process.env.HOME : undefined) },
  session: { cwd: async () => projDir },
}
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))
await new Promise(r => setTimeout(r, 2500))

const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of [...(n.kids ?? []), n.props?.children]) walk(k, f) }
const drawProps = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
  let props
  walk(tree, n => { if (n.type === 'Client') props = n.props.props })
  return props
}

// --- board.tsx 純為人眼核對，跟 board-harness.mjs 同一套渲染方式 -----------
const board = (await import(boardPath)).default
const boardText = props => {
  let state
  const surface = {
    columns: 100, rows: 9,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  const out = board(props, surface)
  const text = (node, acc) => {
    if (node == null || node === false) return acc
    if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
    if (Array.isArray(node)) { for (const n of node) text(n, acc); return acc }
    for (const k of [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]) text(k, acc)
    return acc
  }
  return (out.kids ?? []).map(row => text(row, []).join(''))
}

let props = await drawProps()
console.log('交叉前板面：')
for (const line of boardText(props)) console.log('|' + line + '|')
ok(props.view === 'table', '起始是清單畫面')

const beforeOrder = props.quotes.map(q => q.code)
console.log(`交叉前名次  ${props.quotes.map(q => `${q.code}(${q.pct}%)`).join(' > ')}`)
ok(props.quotes.every(q => q.was === undefined), '交叉前沒有任何一列在翻牌狀態')

// 讓名次第一、第二對調（見 chart-nav.mjs 同一招）
const quotesPath = `${projDir}/.claude/stock-quotes.json`
const before = JSON.parse(await readFile(quotesPath, 'utf8'))
const [topCode, secondCode] = beforeOrder
const swapped = {
  ...before,
  asOf: (clock += 1000),
  quotes: { ...before.quotes, [topCode]: before.quotes[secondCode], [secondCode]: before.quotes[topCode] },
}
await writeFile(quotesPath, JSON.stringify(swapped, null, 2))
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

props = await drawProps()
console.log('\n交叉後板面：')
for (const line of boardText(props)) console.log('|' + line + '|')
const afterOrder = props.quotes.map(q => q.code)
console.log(`交叉後名次  ${props.quotes.map(q => `${q.code}(${q.pct}%)`).join(' > ')}`)
ok(afterOrder[0] === secondCode && afterOrder[1] === topCode, '交叉後名次第一、第二確實對調了（sort 已經重排）')

const crossedRow = props.quotes[0]
ok(
  crossedRow.was?.code === topCode,
  `第 0 列的代碼從 ${topCode} 換成 ${secondCode}，但沒有 was.code 標記翻牌，代碼欄靜靜換人 (PR-a target)`,
)

done()
