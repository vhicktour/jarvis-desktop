import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, realpath, readdir, lstat, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { hash, invariant } from '../core/util'

const exec = promisify(execFile)
export async function git(path: string, args: string[], signal?: AbortSignal) {
  return (
    await exec(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', path, ...args],
      {
        signal,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: path,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          LANG: 'en_US.UTF-8',
        },
      },
    )
  ).stdout.trimEnd()
}
export async function fingerprint(path: string) {
  const head = await git(path, ['rev-parse', 'HEAD'])
  const changes = await git(path, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'])
  const untracked = await git(path, ['ls-files', '--others', '--exclude-standard', '-z'])
  const files: { path: string; hash: string }[] = []
  for (const name of untracked.split('\0').filter(Boolean).sort()) {
    const target = join(path, name)
    const info = await lstat(target)
    invariant(
      info.isFile() && !info.isSymbolicLink() && info.size < 5_000_000,
      'Untracked files must be regular files smaller than 5 MB before creating a review package.',
    )
    files.push({ path: name, hash: hash((await readFile(target)).toString('base64')) })
  }
  return hash({ head, changes, files })
}
export async function prepareWorktree(
  repository: string,
  destination: string,
  baseline: string,
  signal: AbortSignal,
) {
  await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 })
  const configuredFilters = await git(repository, [
    'config',
    '--name-only',
    '--null',
    '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process|required)$',
  ]).catch((error) => {
    if (error.code === 1) return ''
    throw error
  })
  const disabledFilters = configuredFilters
    .split('\0')
    .filter(Boolean)
    .flatMap((key) => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`])
  await git(
    repository,
    [...disabledFilters, 'worktree', 'add', '--detach', destination, baseline],
    signal,
  )
  invariant(
    (await git(destination, ['rev-parse', 'HEAD'])) === baseline,
    'The worktree baseline could not be verified.',
  )
  return destination
}
export async function reviewPackage(path: string, baseline: string) {
  const before = await fingerprint(path)
  const diff = await git(path, ['diff', '--no-ext-diff', '--no-textconv', '--binary', baseline])
  const names = (await git(path, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
  const untracked: { path: string; content: string }[] = []
  let bytes = Buffer.byteLength(diff)
  invariant(
    bytes < 500_000,
    'The diff exceeds the 500 KB review package limit. Narrow the task scope.',
  )
  for (const name of names.sort()) {
    const file = join(path, name)
    const info = await lstat(file)
    invariant(
      info.isFile() && !info.isSymbolicLink(),
      'The review package does not follow symbolic links.',
    )
    invariant(info.size < 200_000, 'A new file is too large for the bounded review package.')
    const content = await readFile(file, 'utf8')
    bytes += Buffer.byteLength(content)
    invariant(
      bytes < 500_000,
      'The change is too large for a single review package. Narrow the task scope.',
    )
    untracked.push({ path: name, content })
  }
  const revision = await fingerprint(path)
  invariant(
    revision === before,
    'The worktree changed while preparing the review package. Try again after edits settle.',
  )
  return { baseline, revision, diff, untracked }
}
export function sandboxProfile(worktree: string, temporary: string, networkAccess = false) {
  const literal = (value: string) => JSON.stringify(value)
  return `(version 1)
(deny default)
(allow process* sysctl-read mach-lookup ipc-posix* signal)
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple") (subpath "/Library/Developer") (subpath "/Applications/Xcode.app") (subpath "/opt/homebrew") (subpath "/dev") (subpath ${literal(worktree)}) (subpath ${literal(temporary)}))
(allow file-write* (subpath ${literal(worktree)}) (subpath ${literal(temporary)}) (literal "/dev/null"))
${networkAccess ? '(allow network*)' : '(deny network*)'}`
}
export async function runCheck(
  worktree: string,
  command: string,
  temporary: string,
  signal: AbortSignal,
  networkAccess = false,
) {
  signal.throwIfAborted()
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  worktree = await realpath(worktree)
  temporary = await realpath(temporary)
  return new Promise<{ output: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/sandbox-exec',
      ['-p', sandboxProfile(worktree, temporary, networkAccess), '/bin/zsh', '-f', '-c', command],
      {
        cwd: worktree,
        detached: true,
        env: {
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
          HOME: temporary,
          TMPDIR: temporary,
          CI: '1',
          LANG: 'en_US.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    let overflow = false
    let timedOut = false
    let escalation: NodeJS.Timeout | undefined
    const stop = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        /* Already stopped. */
      }
      escalation ??= setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          /* Already stopped. */
        }
      }, 1000)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, 180_000)
    signal.addEventListener('abort', stop, { once: true })
    const capture = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output) > 256_000) {
        overflow = true
        output = output.slice(0, 250_000)
        stop()
      }
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const cleanup = () => {
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      signal.removeEventListener('abort', stop)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {
      cleanup()
      if (signal.aborted) reject(new Error('Check interrupted.'))
      else if (timedOut) reject(new Error('Check exceeded its three minute time limit.'))
      else if (overflow) reject(new Error('Check output exceeded 256 KB.'))
      else resolve({ output, exitCode: code })
    })
  })
}
