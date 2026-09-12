import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Models } from '../src/core/models'
import { Skills } from '../src/core/skills'
import { Store } from '../src/core/store'
import { TaskEngine } from '../src/core/tasks'
import { agentExecutor } from '../src/core/agent-task'
import type { ProviderHub } from '../src/providers/hub'
import { Settings } from '../src/shared/contracts'

const profile = resolve(process.argv[2] ?? join(homedir(), 'Library/Application Support/Jarvis'))
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-agent-live-')))
const store = new Store(join(dir, 'ledger.db'), randomBytes(32))
const skills = new Skills(dir)
const models = new Models(
  profile,
  resolve('workers'),
  () => {},
  () => {},
)
const providers = { mcpTools: async () => [] } as unknown as ProviderHub
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  realLocalModel: true,
  externalEffects: false,
  cases: [],
}
const project = {
  id: 'fixture',
  name: 'Agent fixture',
  path: join(dir, 'project'),
  trusted: true,
  checks: [],
  createdAt: new Date().toISOString(),
}
mkdirSync(project.path)
mkdirSync(join(project.path, 'verify-build'))
writeFileSync(join(project.path, 'README.md'), '# Fixture\nThe test color is teal.\n')
writeFileSync(
  join(project.path, 'verify-build/SKILL.md'),
  '---\nname: verify-build\ndescription: Read project checks and verify the build.\n---\nRead the configured checks before choosing a command.\n',
)
store.saveProject(project)
const approvals = new Set<string>()
const engine = new TaskEngine(store, agentExecutor(models, store, providers, skills, dir), () => {
  queueMicrotask(() => {
    for (const approval of store.approvals()) {
      if (approval.decision !== 'pending' || approvals.has(approval.id)) continue
      approvals.add(approval.id)
      const { tool, arguments: args } = approval.proposal
      const permitted =
        (tool === 'skill.install' &&
          args.name === 'verify-build' &&
          args.source === join(project.path, 'verify-build')) ||
        (tool === 'worktree.local' &&
          args.repository === join(dir, 'clone') &&
          String(args.destination).startsWith(join(dir, 'worktrees/'))) ||
        (tool === 'agent.command' &&
          args.command === '/usr/bin/true' &&
          args.networkAccess === false &&
          String(args.cwd).startsWith(join(dir, 'worktrees/')))
      engine.decide(approval.id, permitted ? 'approved' : 'denied', approval.proposal.argumentHash)
    }
  })
})
async function run(objective: string, selected = project) {
  const began = performance.now()
  const task = engine.create(objective, 'local', selected, Settings.parse({}).budget)
  const deadline = Date.now() + 180_000
  while (!['completed', 'failed', 'needs_reconciliation'].includes(store.getTask(task.id).state)) {
    assert.ok(Date.now() < deadline, 'Agent fixture exceeded three minutes')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const current = store.getTask(task.id)
  const result = {
    objective,
    state: current.state,
    elapsedSeconds: (performance.now() - began) / 1000,
    stage: current.stage,
    observations: current.evidence.map(({ label, value, verified }) => ({
      label,
      value,
      verified,
    })),
    providerIds: store.receipts().find((r) => r.taskId === task.id)?.providerIds,
  }
  ;(results.cases as unknown[]).push(result)
  console.log(
    JSON.stringify({
      objective,
      state: current.state,
      seconds: result.elapsedSeconds,
      stage: current.stage,
    }),
  )
  assert.equal(current.state, 'completed', current.stage)
  return current
}
try {
  await models.start()
  await models.warm(['reasoning'])
  await run(
    'List files in the selected project and read README.md to report the test color. Do not run commands or change files.',
  )
  await run(
    'Install the Jarvis skill package in the verify-build directory. Use skill_install. Finish after that package is installed; no shell commands are needed.',
  )
  assert.equal((await skills.list())[0].name, 'verify-build')
  assert.ok(
    readFileSync(join(dir, 'skills/verify-build/SKILL.md'), 'utf8').includes(
      'Read the configured checks',
    ),
  )
  execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      'clone',
      '--shared',
      '--no-checkout',
      resolve('.'),
      join(dir, 'clone'),
    ],
    { stdio: 'pipe' },
  )
  const repository = { ...project, id: 'command-fixture', path: join(dir, 'clone') }
  store.saveProject(repository)
  const task = await run(
    'Run exactly /usr/bin/true in an isolated task worktree, with network false. Do not change files. Finish after its successful exit code is observed.',
    repository,
  )
  assert.ok(task.worktree?.startsWith(join(dir, 'worktrees/')))
  assert.ok(
    task.evidence.some((e) => e.label === 'run_command' && e.value.includes('"exitCode":0')),
  )
  results.passed = true
} catch (error) {
  results.passed = false
  results.error = String(error)
  process.exitCode = 1
} finally {
  await engine.shutdown()
  models.stop()
  store.close()
  rmSync(dir, { recursive: true, force: true })
  writeFileSync('verification/local-agent.json', JSON.stringify(results, null, 2) + '\n')
}
