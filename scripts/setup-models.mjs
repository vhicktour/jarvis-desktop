import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, existsSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
const runtime = resolve('workers/runtime')
mkdirSync(runtime, { recursive: true })
const env = { ...process.env, UV_PYTHON_INSTALL_DIR: runtime }
function run(args) {
  const result = spawnSync('uv', args, { env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
run(['python', 'install', '3.12.12', '--no-bin'])
// uv's convenience alias is absolute; only the pinned distribution belongs in a bundle.
const alias = join(runtime, 'cpython-3.12-macos-aarch64-none')
if (existsSync(alias) && lstatSync(alias).isSymbolicLink()) unlinkSync(alias)
const distribution = readdirSync(runtime).find((name) =>
  name.startsWith('cpython-3.12.12-macos-aarch64'),
)
if (!distribution) throw new Error('The bundled Apple silicon Python runtime was not found.')
const python = join(runtime, distribution, 'bin/python3.12')
if (!existsSync('workers/requirements.lock'))
  run([
    'pip',
    'compile',
    'workers/requirements.in',
    '--python',
    python,
    '--generate-hashes',
    '--quiet',
    '-o',
    'workers/requirements.lock',
  ])
// This interpreter belongs to the application bundle, not the user's system.
run([
  'pip',
  'install',
  '--python',
  python,
  '--break-system-packages',
  '--require-hashes',
  '-r',
  'workers/requirements.lock',
])
writeFileSync(
  'workers/runtime.json',
  JSON.stringify(
    {
      version: 1,
      python: `runtime/${distribution}/bin/python3.12`,
      requirements: 'requirements.lock',
    },
    null,
    2,
  ),
)
