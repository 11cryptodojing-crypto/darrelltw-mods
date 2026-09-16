// Does the board reinstall its frame clock when the host remounts the Client?
// The host's contract: `every` runs "until the returned function is called or
// the instance unmounts", and state is "dropped with the instance".
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
const board = (await import(process.argv[2])).default
const props = JSON.parse(await readFile(process.argv[3], 'utf8'))

let installs = 0
function newInstance(label) {
  let state                      // a fresh instance starts with no state
  const surface = {
    columns: 100, rows: 9,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state },
    setState: s => { state = s },
    every: (ms) => { installs++; console.log(`  ${label}: surface.every(${ms}) called`); return () => {} },
  }
  return surface
}

console.log('instance 1 (fresh module, fresh surface):')
const a = newInstance('a')
board(props, a); board(props, a); board(props, a)

console.log('instance 2 (same module, host remounted the Client):')
const b = newInstance('b')
board(props, b); board(props, b); board(props, b)

console.log(`\ntotal surface.every() installs: ${installs}`)
console.log(installs >= 2 ? 'OK: each instance got a frame clock' : 'BUG: the second instance has NO frame clock')
