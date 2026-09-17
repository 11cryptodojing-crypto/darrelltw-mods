// Minimal pass/fail helper so a dev harness can fail loudly (non-zero exit)
// instead of just printing something a human has to read closely. Kept to
// two functions on purpose - these scripts already do the hard part
// (building a real prop tree against the real hook), this just turns "does
// that look right" into an exit code.
let checks = 0
let failures = 0

/** Records one check. Prints `ok <msg>` or `FAIL <msg>` immediately. */
export function ok(cond, msg) {
  checks++
  if (cond) {
    console.log(`ok   ${msg}`)
  } else {
    failures++
    process.exitCode = 1
    console.log(`FAIL ${msg}`)
  }
}

/** Call once at the end of a harness. Prints a one-line summary. */
export function done() {
  const passed = checks - failures
  console.log(`\n${passed}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`)
  if (failures > 0) process.exitCode = 1
}
