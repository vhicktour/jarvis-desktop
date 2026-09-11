import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What the application was doing, written down where it can be read back.
 *
 * A packaged application cannot be watched while it runs, and "nothing happened" is not something
 * anybody can act on. Bounded, because a log that fills the disk is its own kind of failure.
 */
export function record(dataDir: string, line: string) {
  try {
    const file = join(dataDir, 'runtime.log')
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 64_000)
      writeFileSync(file, '', { mode: 0o600 })
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch {
    /* Diagnostics must never be the reason something cannot run. */
  }
}
