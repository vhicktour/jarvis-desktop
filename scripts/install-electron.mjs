import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
let directory
try {
  directory = dirname(require.resolve('electron/package.json'))
} catch {
  process.exit(0)
}
if (!existsSync(join(directory, 'path.txt'))) {
  const result = spawnSync(process.execPath, [join(directory, 'install.js')], { stdio: 'inherit' })
  process.exit(result.status || 0)
}
