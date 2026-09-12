import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Skills } from '../src/core/skills'
import { addressedText, requestedAction, nativeTask, endConversation } from '../src/shared/intent'
import { agentExecutor } from '../src/core/agent-task'
import { Models } from '../src/core/models'
import { ProviderHub } from '../src/providers/hub'
import { Store } from '../src/core/store'
import { TaskEngine } from '../src/core/tasks'
import { Settings } from '../src/shared/contracts'

const skillText =
  '---\nname: verify-build\ndescription: Verify the selected project build.\n---\nRead the project checks and run the appropriate check.\n'
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < end, 'Expected task state did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
test('explicit action routing preserves normal discussion and existing native tasks', () => {
  assert.equal(addressedText('Hey, Jarvis, fix the build.'), 'fix the build.')
  for (const text of [
    'Can you please install the skill?',
    'Jarvis run the test suite',
    'Fix the click handler',
    'Please look up the documentation',
  ])
    assert.equal(requestedAction(text), true, text)
  for (const text of [
    'How do I install a package?',
    'Do not run anything',
    'What does the click handler do?',
    'I read a book',
  ])
    assert.equal(requestedAction(text), false, text)
  assert.equal(nativeTask('Can you create a file called hello.txt?'), true)
  assert.equal(nativeTask('Fix the click handler in the file'), false)
  assert.equal(endConversation('Jarvis, go to sleep.'), true)
  assert.equal(endConversation('Stop the server in my project'), false)
})

test('a saved wake name is stripped before conversation, task and stop routing', () => {
  for (const name of ['Friday', 'Computer', 'Miss Moneypenny']) {
    assert.equal(addressedText(`Hey ${name}, what is two plus two?`, name), 'what is two plus two?')
    assert.equal(addressedText(`${name}!`, name), '')
    assert.equal(
      requestedAction(addressedText(`Hey ${name}, create a file called hello.txt`, name)),
      true,
    )
    assert.equal(endConversation(addressedText(`${name}, go to sleep`, name)), true)
    assert.equal(addressedText('Jarvis, tell me a joke', name), 'Jarvis, tell me a joke')
  }
  assert.equal(Settings.parse({}).wakeName, 'Jarvis')
  assert.equal(Settings.parse({ wakeName: '  Friday  ' }).wakeName, 'Friday')
  for (const wakeName of [
    '',
    'A',
    'x'.repeat(33),
    '.*',
    'Hey\nFriday',
    'A B C D',
    'Friday/Computer',
  ])
    assert.equal(Settings.safeParse({ wakeName }).success, false, wakeName)
})

test('skills install exact reviewed bytes and reject changed packages, links and credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-skills-test-'))
  try {
    const skills = new Skills(join(dir, 'data'))
    const source = join(dir, 'source')
    await mkdir(source)
    await writeFile(join(source, 'SKILL.md'), skillText)
    const reviewed = await skills.inspect(source)
    await writeFile(join(source, 'SKILL.md'), skillText + 'Changed.\n')
    await assert.rejects(skills.install(source, reviewed.hash), /changed/)
    await writeFile(join(source, 'SKILL.md'), skillText)
    await symlink('/etc/hosts', join(source, 'external.txt'))
    await assert.rejects(skills.inspect(source), /symbolic links/)
    await rm(join(source, 'external.txt'))
    await writeFile(join(source, '.env'), 'not a real secret')
    await assert.rejects(skills.inspect(source), /secrets/)
    await rm(join(source, '.env'))
    const result = await skills.install(source, reviewed.hash)
    assert.equal(await readFile(join(result.path, 'SKILL.md'), 'utf8'), skillText)
    assert.equal((await skills.list()).length, 1)
    await assert.rejects(skills.read('../source'))
    await assert.rejects(skills.remove('verify-build', 'wrong-hash'), /changed/)
    await skills.remove('verify-build', reviewed.hash)
    assert.deepEqual(await skills.list(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('local agent skill installation requires ledger approval, records session, and proposes scoped learning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-agent-test-'))
  const store = new Store(join(dir, 'store.db'), randomBytes(32))
  const source = join(dir, 'project')
  await mkdir(source)
  const packagePath = join(source, 'verify-build')
  await mkdir(packagePath)
  await writeFile(join(packagePath, 'SKILL.md'), skillText)
  const skills = new Skills(join(dir, 'data'))
  const project = {
    id: 'project-test',
    name: 'Test project',
    path: source,
    trusted: true,
    checks: [],
    createdAt: new Date().toISOString(),
  }
  store.saveProject(project)
  const actions = [
    { action: 'read_file', path: 'missing.md' },
    { action: 'read_file', path: 'verify-build/SKILL.md' },
    { action: 'done', summary: 'The skill is installed.' },
    { action: 'skill_install', path: 'verify-build' },
    {
      action: 'done',
      summary: 'The inspected package was installed.',
      lesson: 'Inspect SKILL.md before installing a package.',
    },
  ]
  const models = {
    request: async () => ({ text: JSON.stringify(actions.shift()) }),
  } as unknown as Models
  const providers = { mcpTools: async () => [] } as unknown as ProviderHub
  const engine = new TaskEngine(
    store,
    agentExecutor(models, store, providers, skills, dir),
    () => {},
  )
  try {
    const task = engine.create(
      'Install the verify-build skill',
      'local',
      project,
      Settings.parse({}).budget,
    )
    await until(() => store.getTask(task.id).state === 'awaiting_approval')
    assert.equal((await skills.list()).length, 0)
    const approval = store.approvals().find((a) => a.decision === 'pending')!
    assert.equal(approval.proposal.tool, 'skill.install')
    assert.equal(approval.proposal.arguments.instructions, skillText)
    engine.decide(approval.id, 'approved', approval.proposal.argumentHash)
    await until(() => store.getTask(task.id).state === 'completed')
    assert.equal((await skills.list())[0].name, 'verify-build')
    assert.ok(store.receipts()[0].providerIds['local-agent'])
    const proposed = store.memories(project.id)[0]
    assert.equal(proposed.reviewState, 'proposed')
    assert.deepEqual(proposed.sourceIds, [task.id])
    assert.equal(store.searchMemory('SKILL', project.id).length, 0)
    assert.equal(store.memories('personal').length, 0)
  } finally {
    await engine.shutdown()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('local agent cannot turn a failed prior command into completion by reading a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-agent-failure-'))
  const store = new Store(join(dir, 'store.db'), randomBytes(32))
  try {
    const actions = [
      { action: 'skill_read', name: 'verify-build' },
      { action: 'done', summary: 'All fixed' },
    ]
    const executor = agentExecutor(
      { request: async () => ({ text: JSON.stringify(actions.shift()) }) } as unknown as Models,
      store,
      { mcpTools: async () => [] } as unknown as ProviderHub,
      {
        list: async () => [],
        read: async () => ({ name: 'verify-build', text: skillText, files: [] }),
      } as unknown as Skills,
      dir,
    )
    const task = { id: 'task-test', revision: 1, objective: 'Fix a command', scope: 'personal' }
    const run = {
      signal: new AbortController().signal,
      stage: () => {},
      session: () => {},
      evidence: () => {},
      succeeded: (tool: string) =>
        tool === 'agent.command'
          ? [
              {
                proposal: { tool, arguments: { command: 'false' } },
                result: { exitCode: 1, output: 'Failed' },
              },
            ]
          : [],
    }
    await assert.rejects(executor(task as any, undefined, run as any), /last command failed/)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
