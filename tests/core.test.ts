import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  existsSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Store } from '../src/core/store'
import { TaskEngine, type TaskExecutor, type TaskRun } from '../src/core/tasks'
import { hash, now, uid } from '../src/core/util'
import { Settings, Task, Command } from '../src/shared/contracts'
import { scopedPath, literalFileContent, localExecutor } from '../src/core/local-task'
import type { Models } from '../src/core/models'
import { runCheck } from '../src/providers/workspace'

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-test-'))
  const key = randomBytes(32)
  const file = join(dir, 'jarvis.db')
  const store = new Store(file, key)
  return {
    dir,
    key,
    file,
    store,
    close: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
async function until(predicate: () => boolean, message: string) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const budget = Settings.parse({}).budget
test('literal file content preserves finalized speech and typed wording', () => {
  assert.equal(
    literalFileContent(
      'Create a file named receipt TXT containing exactly a quietly capable companion.',
    ),
    'a quietly capable companion.',
  )
  assert.equal(
    literalFileContent(
      'Create a file receipt.txt containing exactly: "A quietly capable companion."',
    ),
    'A quietly capable companion.',
  )
  assert.equal(literalFileContent('Explain what containing exactly means'), undefined)
})
function memory(text: string, scope = 'personal') {
  return {
    id: uid(),
    scope,
    category: 'semantic' as const,
    text,
    source: 'Test fixture',
    sourceIds: [],
    createdAt: now(),
    updatedAt: now(),
    explicit: true,
    reviewState: 'approved' as const,
  }
}

test('sparse settings patches never reset unrelated preferences', () => {
  const command = Command.parse({ type: 'settings.update', patch: { pinned: true } })
  assert.equal(command.type, 'settings.update')
  if (command.type === 'settings.update') assert.deepEqual(command.patch, { pinned: true })
})

test('database and WAL conceal durable content, reopen with the right key, reject a wrong key', () => {
  const db = database()
  const secret = 'jarvis-encryption-fixture-unique-sentinel'
  db.store.saveMemory(memory(secret))
  assert.equal(readFileSync(db.file).includes(Buffer.from('SQLite format 3')), false)
  assert.equal(readFileSync(db.file).includes(Buffer.from(secret)), false)
  assert.equal(readFileSync(db.file + '-wal').includes(Buffer.from(secret)), false)
  db.store.close()
  const reopened = new Store(db.file, db.key)
  assert.equal(reopened.memories()[0].text, secret)
  reopened.close()
  assert.throws(() => new Store(db.file, randomBytes(32)))
  rmSync(db.dir, { recursive: true, force: true })
})

test('memory retrieval respects scope, review status, correction, and derived deletion', () => {
  const db = database()
  const original = memory('The preferred deployment window is Tuesday', 'project-a')
  const corrected = {
    ...memory('The preferred deployment window is Thursday', 'project-a'),
    supersedes: original.id,
    sourceIds: [original.id],
  }
  db.store.saveMemory(original)
  db.store.saveMemory(memory('Private deployment details', 'project-b'))
  db.store.saveMemory({
    ...memory('Unreviewed deployment assumption', 'project-a'),
    reviewState: 'proposed',
  })
  assert.equal(db.store.searchMemory('deployment', 'project-a').length, 1)
  db.store.saveMemory(corrected)
  assert.equal(db.store.searchMemory('deployment', 'project-a')[0].id, corrected.id)
  db.store.embedMemory(corrected.id, 'fixture-v1', [1, 0, 0])
  assert.equal(
    db.store.searchMemory('', 'project-a', { revision: 'fixture-v1', values: [1, 0, 0] })[0].id,
    corrected.id,
  )
  db.store.forget(original.id)
  assert.equal(db.store.searchMemory('deployment', 'project-a').length, 0)
  assert.equal(db.store.memory(corrected.id), undefined)
  assert.equal(
    (db.store.db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get() as { n: number }).n,
    0,
  )
  db.close()
})

test('provider completion cannot complete a task without observed evidence', async () => {
  const db = database()
  const engine = new TaskEngine(
    db.store,
    async () => ({ summary: 'Provider said done', limitations: [] }),
    () => {},
  )
  const task = engine.create('Fixture with no evidence', 'local', undefined, budget)
  await until(
    () => db.store.getTask(task.id).state === 'failed',
    'Task did not reject unsupported completion',
  )
  assert.match(db.store.getTask(task.id).error!, /verified evidence/)
  assert.equal(db.store.receipts()[0].status, 'failed')
  db.close()
})

test('approval binds arguments, revision, target state, and exactly one intended effect', async () => {
  const db = database()
  let effects = 0
  const engine = new TaskEngine(
    db.store,
    async (_task, _project, run) => {
      const approval = await run.authorize(
        'fixture.write',
        { content: 'approved text' },
        '/fixture/result',
        'state-a',
        'Write fixture',
      )
      await run.effect(approval, 'state-a', async () => {
        effects++
        return 'observed'
      })
      await assert.rejects(
        run.effect(approval, 'state-a', async () => {
          effects++
          return 'duplicate'
        }),
      )
      run.evidence({
        kind: 'file',
        label: 'Observed fixture',
        value: 'observed',
        hash: hash('observed'),
        verified: true,
      })
      return { summary: 'Fixture verified', limitations: [] }
    },
    () => {},
  )
  const task = engine.create('Approve exact fixture', 'local', undefined, budget)
  await until(() => db.store.approvals().length === 1, 'Approval was not created')
  const approval = db.store.approvals()[0]
  assert.throws(() => engine.decide(approval.id, 'approved', 'wrong-arguments'), /stale/)
  engine.decide(approval.id, 'approved', approval.proposal.argumentHash)
  await until(
    () => db.store.getTask(task.id).state === 'completed',
    'Verified task did not complete',
  )
  assert.equal(effects, 1)
  const events = db.store.events(task.id)
  assert.ok(
    events.findIndex((e) => e.type === 'verification.started') <
      events.findIndex((e) => e.type === 'completed'),
  )
  assert.deepEqual(
    events.map((e) => e.sequence),
    events.map((_, index) => index + 1),
  )
  assert.equal(db.store.receipts()[0].evidence.length, 1)
  db.close()
})

test('changed targets stop execution before effects and stale approvals are rejected after steering', async () => {
  const db = database()
  let effects = 0
  const engine = new TaskEngine(
    db.store,
    async (_task, _project, run) => {
      const approval = await run.authorize(
        'fixture.write',
        { content: 'test' },
        '/fixture',
        'before',
        'Write fixture',
      )
      await run.effect(approval, 'after', async () => {
        effects++
      })
      return { summary: '', limitations: [] }
    },
    () => {},
  )
  const task = engine.create('Target changes', 'local', undefined, budget)
  await until(() => db.store.approvals().length === 1, 'No approval')
  const approval = db.store.approvals()[0]
  engine.decide(approval.id, 'approved', approval.proposal.argumentHash)
  await until(() => db.store.getTask(task.id).state === 'failed', 'Changed target was not rejected')
  assert.equal(effects, 0)
  const task2 = engine.create('Steering invalidates old approval', 'local', undefined, budget)
  await until(() => db.store.approvals().length === 1, 'No second approval')
  const old = db.store.approvals()[0]
  engine.steer(task2.id, 1, 'Changed instruction')
  assert.throws(
    () => engine.decide(old.id, 'approved', old.proposal.argumentHash),
    /no longer pending/,
  )
  assert.equal(db.store.getTask(task2.id).revision, 2)
  engine.control(task2.id, 'cancel')
  await until(
    () => db.store.getTask(task2.id).state === 'cancelled' && engine.activeCount === 0,
    'Cancellation did not settle',
  )
  db.close()
})

test('uncertain effects survive restart and are never replayed automatically', async () => {
  const db = database()
  const engine = new TaskEngine(
    db.store,
    async (_t, _p, run) => {
      const approval = await run.authorize(
        'external.fixture',
        {},
        '/destination',
        'initial',
        'External fixture',
      )
      await run.effect(approval, 'initial', async () => {
        throw new Error('Connection lost after dispatch')
      })
      return { summary: '', limitations: [] }
    },
    () => {},
  )
  const task = engine.create('Uncertain outcome', 'local', undefined, budget)
  await until(() => db.store.approvals().length === 1, 'No approval')
  const approval = db.store.approvals()[0]
  engine.decide(approval.id, 'approved', approval.proposal.argumentHash)
  await until(
    () => db.store.getTask(task.id).state === 'needs_reconciliation',
    'Uncertain effect not retained',
  )
  let replayed = false
  const recovered = new TaskEngine(
    db.store,
    async () => {
      replayed = true
      return { summary: '', limitations: [] }
    },
    () => {},
  )
  recovered.recover()
  assert.equal(replayed, false)
  assert.equal(db.store.uncertainEffects(task.id).length, 1)
  assert.throws(() => recovered.control(task.id, 'resume'), /Only a paused/)
  db.close()
})

test('100 task cancellation trials preserve a responsive control boundary', async () => {
  const db = database()
  const durations: number[] = []
  const engine = new TaskEngine(
    db.store,
    async (_t, _p, run) => {
      await new Promise<void>((_resolve, reject) =>
        run.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }),
      )
      return { summary: '', limitations: [] }
    },
    () => {},
  )
  for (let index = 0; index < 100; index++) {
    const task = engine.create(`Cancellation fixture ${index}`, 'local', undefined, budget)
    const start = performance.now()
    engine.control(task.id, 'cancel')
    durations.push(performance.now() - start)
    await until(
      () => db.store.getTask(task.id).state === 'cancelled',
      'Cancellation did not settle',
    )
  }
  durations.sort((a, b) => a - b)
  assert.ok(durations[94] < 100, `Task control p95 ${durations[94].toFixed(2)} ms exceeded 100 ms`)
  console.log(
    `Task-control boundary: 100 trials, p95 ${durations[94].toFixed(2)} ms (service only; not audio).`,
  )
  db.close()
})

test('cloud tasks need a configured ceiling and trusted repository', () => {
  const db = database()
  const engine = new TaskEngine(
    db.store,
    async () => ({ summary: '', limitations: [] }),
    () => {},
  )
  assert.throws(() => engine.create('Cloud fixture', 'codex', undefined, budget), /usage ceiling/)
  assert.throws(
    () => engine.create('Saved routine ceiling', 'claude', undefined, { ...budget, maxCostUsd: 1 }),
    /usage ceiling/,
  )
  db.store.setSetting('preferences', { budget: { ...budget, maxCostUsd: 1 } })
  assert.throws(
    () => engine.create('Cloud fixture', 'claude', undefined, { ...budget, maxCostUsd: 1 }),
    /repository/,
  )
  assert.equal(db.store.tasks().length, 0)
  assert.equal(Command.safeParse({ type: 'shell', command: 'anything' }).success, false)
  db.close()
})

test('file scope rejects traversal, secret paths, and symlink escapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-paths-'))
  const outside = mkdtempSync(join(tmpdir(), 'jarvis-outside-'))
  symlinkSync(outside, join(dir, 'escape'))
  await assert.rejects(scopedPath(dir, '../outside.txt'))
  await assert.rejects(scopedPath(dir, '.git/config'))
  await assert.rejects(scopedPath(dir, 'escape/secret.txt'))
  assert.equal(
    await scopedPath(dir, 'notes/fixture.txt'),
    join(realpathSync(dir), 'notes/fixture.txt'),
  )
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test(
  'scoped checks enforce filesystem and network denial on macOS',
  { skip: process.platform !== 'darwin' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-sandbox-'))
    const project = join(dir, 'worktree')
    const temp = join(dir, 'temporary')
    mkdirSync(project)
    const signal = new AbortController().signal
    const allowed = await runCheck(project, '/usr/bin/touch allowed.txt', temp, signal)
    assert.equal(allowed.exitCode, 0, allowed.output)
    assert.equal(existsSync(join(project, 'allowed.txt')), true)
    const denied = await runCheck(
      project,
      `/usr/bin/touch ${join(dir, 'outside.txt')}`,
      temp,
      signal,
    )
    assert.notEqual(denied.exitCode, 0)
    assert.equal(existsSync(join(dir, 'outside.txt')), false)
    const network = await runCheck(
      project,
      '/usr/bin/curl --max-time 2 http://127.0.0.1:5190',
      temp,
      signal,
    )
    assert.notEqual(network.exitCode, 0)
    rmSync(dir, { recursive: true, force: true })
  },
)

test('cancellation after dispatch preserves a confirmed successful effect', async () => {
  const db = database()
  let finish!: () => void
  let dispatched = false
  const engine = new TaskEngine(
    db.store,
    async (_t, _p, run) => {
      const approval = await run.authorize(
        'fixture.write',
        {},
        '/fixture',
        'before',
        'Write fixture',
      )
      await run.effect(approval, 'before', async () => {
        dispatched = true
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return { observed: 'created' }
      })
      return { summary: 'Done', limitations: [] }
    },
    () => {},
  )
  const task = engine.create('Cancel a dispatched action', 'local', undefined, budget)
  await until(() => db.store.approvals().length === 1, 'No approval')
  const approval = db.store.approvals()[0]
  engine.decide(approval.id, 'approved', approval.proposal.argumentHash)
  await until(() => dispatched, 'Not dispatched')
  engine.control(task.id, 'cancel')
  finish()
  await until(() => engine.activeCount === 0, 'Did not stop')
  assert.equal(db.store.getTask(task.id).state, 'cancelled')
  assert.equal(db.store.uncertainEffects(task.id).length, 0)
  assert.deepEqual(db.store.getTask(task.id).completedEffects, ['Write fixture'])
  db.close()
})

test('steering waits for a stopped executor and records its inspected partial changes', async () => {
  const db = database()
  let dispatched = false
  let inspected = false
  let secondStarted = false
  const engine = new TaskEngine(
    db.store,
    async (task, _p, run) => {
      if (task.revision === 2) {
        secondStarted = true
        assert.equal(inspected, true)
        run.evidence({ kind: 'result', label: 'Revision two', value: 'Observed', verified: true })
        return { summary: 'Second revision verified', limitations: [] }
      }
      const approval = await run.authorize(
        'fixture.write',
        {},
        '/fixture',
        'before',
        'Change fixture',
      )
      await run.effect(
        approval,
        'before',
        async () => {
          dispatched = true
          await new Promise<void>((_resolve, reject) =>
            run.signal.addEventListener(
              'abort',
              () => {
                setTimeout(() => reject(new Error('Executor stopped')), 40)
              },
              { once: true },
            ),
          )
        },
        async () => {
          inspected = true
          return { partialDiff: 'Known remaining change' }
        },
      )
      return { summary: '', limitations: [] }
    },
    () => {},
  )
  const task = engine.create('Steer an active effect', 'local', undefined, budget)
  await until(() => db.store.approvals().length === 1, 'No approval')
  const approval = db.store.approvals()[0]
  engine.decide(approval.id, 'approved', approval.proposal.argumentHash)
  await until(() => dispatched, 'Not dispatched')
  engine.steer(task.id, 1, 'Apply the correction')
  assert.equal(secondStarted, false)
  await until(() => engine.activeCount === 0, 'Did not settle')
  assert.equal(db.store.getTask(task.id).state, 'completed')
  assert.equal(db.store.getTask(task.id).revision, 2)
  assert.equal(db.store.uncertainEffects(task.id).length, 0)
  assert.equal(db.store.getTask(task.id).completedEffects.length, 1)
  db.close()
})

test('shutdown never starts queued work and leaves resumable tasks durable', async () => {
  const db = database()
  let executions = 0
  const engine = new TaskEngine(
    db.store,
    async (_task, _project, run) => {
      executions++
      await new Promise<void>((_resolve, reject) =>
        run.signal.addEventListener('abort', () => reject(new Error('Closing')), { once: true }),
      )
      return { summary: '', limitations: [] }
    },
    () => {},
  )
  const first = engine.create('Active before shutdown', 'local', undefined, budget)
  const second = engine.create('Queued before shutdown', 'local', undefined, budget)
  await engine.shutdown()
  assert.equal(executions, 1)
  assert.equal(db.store.getTask(first.id).state, 'paused')
  assert.equal(db.store.getTask(second.id).state, 'queued')
  engine.recover()
  assert.equal(db.store.getTask(second.id).state, 'paused')
  db.close()
})

test('forgetting a correction removes its history and sourced replies', () => {
  const db = database()
  const first = memory('Favourite colour: blue')
  const second = {
    ...memory('Favourite colour: green'),
    supersedes: first.id,
    sourceIds: [first.id],
  }
  db.store.saveMemory(first)
  db.store.saveMemory(second)
  db.store.saveMessage({
    id: uid(),
    role: 'assistant',
    text: 'Your favourite is green.',
    scope: 'personal',
    createdAt: now(),
    sources: [{ id: second.id, label: 'Memory' }],
  })
  db.store.forget(second.id)
  assert.equal(db.store.memory(first.id), undefined)
  assert.equal(db.store.memory(second.id), undefined)
  assert.equal(db.store.messages('personal').length, 0)
  db.close()
})

test('resuming after a successful file write verifies the preserved file without dispatching again', async () => {
  const db = database()
  const project = {
    id: uid(),
    name: 'Recovery fixture',
    path: realpathSync(db.dir),
    trusted: true,
    checks: [],
    createdAt: now(),
  }
  db.store.saveProject(project)
  let plans = 0
  let writes = 0
  let taskId = ''
  const model = {
    request: async () => {
      plans++
      return {
        text: JSON.stringify({
          action: 'create_file',
          path: 'kept.txt',
          content: 'Keep this exact text.',
        }),
      }
    },
  } as unknown as Models
  const engine = new TaskEngine(
    db.store,
    localExecutor(model, async () => {
      writes++
      writeFileSync(join(project.path, 'kept.txt'), 'Keep this exact text.')
      engine.control(taskId, 'pause')
      return true as any
    }),
    () => {},
  )
  const task = engine.create('Create a file named kept.txt.', 'local', project, budget)
  taskId = task.id
  await until(() => db.store.approvals().length === 1, 'Missing file approval')
  const approval = db.store.approvals()[0]
  engine.decide(approval.id, 'approved', approval.proposal.argumentHash)
  await until(() => engine.activeCount === 0, 'File write did not pause')
  assert.equal(db.store.getTask(task.id).state, 'paused')
  engine.control(task.id, 'resume')
  await until(() => engine.activeCount === 0, 'File verification did not finish')
  assert.equal(db.store.getTask(task.id).state, 'completed')
  assert.equal(plans, 1)
  assert.equal(writes, 1)
  assert.equal(readFileSync(join(project.path, 'kept.txt'), 'utf8'), 'Keep this exact text.')
  await engine.shutdown()
  db.close()
})

test('provider usage remains cumulative across task revisions', async () => {
  const db = database()
  const engine = new TaskEngine(
    db.store,
    async (task, _project, run) => {
      run.usage(0.25)
      if (task.revision === 1)
        await new Promise<void>((_resolve, reject) =>
          run.signal.addEventListener(
            'abort',
            () => {
              run.usage(0.1)
              reject(new Error('Steered'))
            },
            { once: true },
          ),
        )
      run.evidence({ kind: 'result', label: 'Fixture', value: 'Result', verified: true })
      return { summary: 'Fixture completed', limitations: [] }
    },
    () => {},
  )
  const task = engine.create('Cumulative usage fixture', 'local', undefined, budget)
  engine.steer(task.id, 1, 'Continue the fixture')
  await until(() => engine.activeCount === 0, 'Usage fixture did not finish')
  assert.equal(db.store.getTask(task.id).costUsd, 0.6)
  await engine.shutdown()
  db.close()
})
