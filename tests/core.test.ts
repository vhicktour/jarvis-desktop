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
import {
  scopedPath,
  literalFileContent,
  localExecutor,
  locateBySight,
} from '../src/core/local-task'
import { Models } from '../src/core/models'
import { runCheck } from '../src/providers/workspace'
import { VaultIndex, chunkNote, looksSecret, noteTitle, splitFrontmatter } from '../src/core/vault'
import { containRegion } from '../src/shared/geometry'

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
  // Saving a record clears its chunk, which is why approving a memory writes the embedding again.
  db.store.saveMemory({ ...corrected, reviewState: 'approved' })
  assert.equal(
    db.store.searchMemory('', 'project-a', { revision: 'fixture-v1', values: [1, 0, 0] }).length,
    0,
  )
  db.store.embedMemory(corrected.id, 'fixture-v1', [1, 0, 0])
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

test('a model check records what it observed and never runs twice at once', async () => {
  const manifests: Record<string, { revision: string; qualified: boolean } | undefined> = {
    silero: { revision: 'silero-1', qualified: false },
    'smart-turn': { revision: 'turn-1', qualified: false },
  }
  let checks = 0
  const models = new Models(
    tmpdir(),
    tmpdir(),
    () => {},
    () => {},
  )
  models.process = {
    request: async (method: string, params: { id: string }) => {
      if (method === 'models.status') return manifests
      checks++
      await new Promise((resolve) => setTimeout(resolve, 20))
      manifests[params.id] = { revision: 'turn-1', qualified: true }
      return { id: params.id, qualified: true, checks: [], detail: 'Fixture passed.' }
    },
  } as unknown as (typeof models)['process']
  await models.refresh()
  // Installed is not qualified: the promotion gate reads the second flag, not the first.
  assert.equal(models.has('smart-turn'), true)
  assert.equal(models.qualified('smart-turn'), false)
  assert.equal(models.has('kokoro'), false)
  const running = models.qualify('smart-turn')
  await assert.rejects(models.qualify('smart-turn'), /already being checked/)
  assert.equal((await running).qualified, true)
  assert.equal(checks, 1)
  assert.equal(models.qualified('smart-turn'), true)
  assert.equal(models.qualified('silero'), false)
  await assert.rejects(models.qualify('nothing-here'), /Unknown model/)
})

test('note chunking keeps its heading, its frontmatter title, and its credentials out', () => {
  const raw =
    '---\ntitle: Overlay decisions\ntags: [ jarvis ]\n---\n\n# Overlay\n\nThe orb docks 24 points inside the work area.\n\n## Credentials\n\napi_key: abcdefghijklmnop\n'
  const { frontmatter, body } = splitFrontmatter(raw)
  assert.match(frontmatter, /^title: Overlay decisions$/m)
  assert.equal(body.startsWith('\n# Overlay'), true)
  assert.equal(noteTitle('personal/orb.md', body, frontmatter), 'Overlay decisions')
  assert.equal(noteTitle('personal/orb.md', body, ''), 'Overlay')
  assert.equal(noteTitle('personal/orb.md', 'no heading here', ''), 'orb')
  const chunks = chunkNote(body)
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    ['Overlay', 'Credentials'],
  )
  assert.equal(looksSecret(chunks[0].text), false)
  assert.equal(looksSecret(chunks[1].text), true)
  // A section without blank lines still breaks rather than growing without bound.
  const dense = chunkNote(
    '# Table\n' + Array.from({ length: 400 }, (_, i) => `| row ${i} |`).join('\n'),
    200,
  )
  assert.ok(dense.length > 1, 'an unbroken block was never split')
  assert.ok(Math.max(...dense.map((chunk) => chunk.text.length)) <= 4000)
})

test('a notes folder is indexed for recall, re-read on change, and forgotten without touching memory', async () => {
  const db = database()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-vault-')))
  const note = join(dir, 'personal', 'orb.md')
  mkdirSync(join(dir, 'personal'))
  mkdirSync(join(dir, '.obsidian'))
  writeFileSync(join(dir, '.obsidian', 'workspace.json'), '{"orb":"docks"}')
  writeFileSync(join(dir, 'ignored.txt'), 'The orb docks in a file Jarvis does not index.')
  writeFileSync(
    note,
    '---\ntitle: Overlay decisions\n---\n\n# Overlay\n\nThe orb docks 24 points inside the work area.\n\n## Credentials\n\napi_key: abcdefghijklmnop\n',
  )
  db.store.saveMemory(memory('I prefer the orb on the right.'))
  const models = { records: [] } as unknown as Models
  const vault = new VaultIndex(db.store, models, () => {})
  await vault.connect(dir)
  await vault.sync()
  assert.equal(vault.status().notes, 1)
  assert.equal(vault.status().chunks, 1, 'the credential passage was indexed')
  assert.equal(vault.status().redacted, 1)
  assert.equal(vault.status().skipped, 0)
  assert.equal(vault.status().path, dir)
  const found = db.store.searchNotes('orb docks work area', 'personal')
  assert.equal(found.length, 1)
  assert.equal(found[0].title, 'Overlay decisions')
  assert.equal(found[0].heading, 'Overlay')
  assert.match(found[0].text, /24 points/)
  assert.equal(db.store.searchNotes('abcdefghijklmnop', 'personal').length, 0)
  assert.equal(db.store.searchNotes('orb docks', 'brief-project').length, 0)
  writeFileSync(join(dir, 'plain.md'), '# Plain\n\nNothing sensitive here at all.\n')
  await vault.sync()
  assert.equal(vault.status().notes, 2)
  // An incremental pass re-reads one note but must still report the whole index.
  assert.equal(vault.status().redacted, 1)
  // Reopening must not replay the migration that created the note tables.
  const reopened = new Store(db.file, db.key)
  assert.equal(reopened.noteSummary().notes, 2)
  reopened.close()
  writeFileSync(note, '# Overlay\n\nThe orb now docks 32 points inside the work area.\n')
  await vault.sync()
  assert.match(db.store.searchNotes('docks 32', 'personal')[0].text, /32 points/)
  assert.equal(vault.status().notes, 2)
  assert.equal(vault.status().redacted, 0, 'the rewritten note no longer holds a credential')
  rmSync(note)
  rmSync(join(dir, 'plain.md'))
  await vault.sync()
  assert.equal(vault.status().notes, 0)
  assert.equal(db.store.searchNotes('docks', 'personal').length, 0)
  vault.forget()
  assert.equal(vault.status().path, undefined)
  assert.equal(db.store.searchMemory('orb right', 'personal').length, 1, 'memory was forgotten too')
  vault.stop()
  rmSync(dir, { recursive: true, force: true })
  db.close()
})

test('an existing database gains the note index without disturbing what it already holds', () => {
  const db = database()
  db.store.saveMemory(memory('Keep this through the upgrade.'))
  // Return the file to the shape the previous release left behind.
  db.store.db.exec(
    'DROP TABLE note_fts; DROP TABLE note_chunks; DROP TABLE notes; PRAGMA user_version = 1;',
  )
  db.store.close()
  const upgraded = new Store(db.file, db.key)
  assert.equal(upgraded.db.pragma('user_version', { simple: true }), 2)
  assert.deepEqual(upgraded.noteSummary(), {
    notes: 0,
    chunks: 0,
    embedded: 0,
    bytes: 0,
    redacted: 0,
  })
  assert.equal(upgraded.searchMemory('upgrade', 'personal').length, 1)
  upgraded.saveNote({ path: 'a.md', title: 'A', scope: 'personal', contentHash: 'h', bytes: 4 }, [
    { heading: '', text: 'Upgraded index accepts writes.' },
  ])
  assert.equal(upgraded.searchNotes('upgraded index', 'personal').length, 1)
  upgraded.close()
  db.close()
})

test('a drawn region stays on screen and never shrinks below the capture minimum', () => {
  const view = { width: 1000, height: 800 }
  const at = (x: number, y: number, width: number, height: number) =>
    containRegion({ x, y, width, height }, view)
  assert.deepEqual(at(10, 20, 300, 200), { x: 10, y: 20, width: 300, height: 200 })
  assert.deepEqual(at(950, 780, 300, 200), { x: 700, y: 600, width: 300, height: 200 })
  assert.deepEqual(at(-50, -50, 300, 200), { x: 0, y: 0, width: 300, height: 200 })
  // The native capture refuses anything under sixteen points, so the interface cannot offer one.
  assert.deepEqual(at(10, 10, 2, 2), { x: 10, y: 10, width: 16, height: 16 })
  assert.deepEqual(at(0, 0, 5000, 5000), { x: 0, y: 0, width: 1000, height: 800 })
  assert.deepEqual(at(10.4, 10.6, 100.5, 100.4), { x: 10, y: 11, width: 101, height: 100 })
})

test('a pressed control names itself in the approval and is never pressed twice', async () => {
  const db = database()
  let presses = 0
  let plans = 0
  let taskId = ''
  const model = {
    request: async () => {
      plans++
      return {
        text: JSON.stringify({ action: 'press_control', app: 'Fixture App', label: 'Send' }),
      }
    },
  } as unknown as Models
  const controls = [
    {
      path: [0, 2],
      role: 'AXButton',
      label: 'Send',
      enabled: true,
      x: 10,
      y: 20,
      width: 80,
      height: 24,
    },
    {
      path: [0, 3],
      role: 'AXButton',
      label: 'Cancel',
      enabled: true,
      x: 100,
      y: 20,
      width: 80,
      height: 24,
    },
  ]
  const engine: TaskEngine = new TaskEngine(
    db.store,
    localExecutor(
      model,
      (async (method: string, params: any) => {
        if (method === 'ui.applications')
          return [{ bundleId: 'com.example.fixture', app: 'Fixture App' }]
        if (method === 'ui.elements') return { elements: controls }
        if (method !== 'ui.press') throw new Error(`unexpected ${method}`)
        if (params.dryRun) return { resolved: true, pressed: false }
        presses++
        // Stop the task the instant the press lands, the way a crash or a pause would.
        engine.control(taskId, 'pause')
        return { resolved: true, pressed: true, app: 'Fixture App', label: 'Send' }
      }) as any,
      (id) => id === 'automation',
    ),
    () => {},
  )
  const task = engine.create('Press Send in Fixture App', 'local', undefined, budget)
  taskId = task.id
  await until(() => db.store.approvals().length === 1, 'No press approval was requested')
  const approval = db.store.approvals()[0]
  const proposal = approval.proposal
  assert.equal(proposal.tool, 'ui.press')
  assert.equal(proposal.target, 'Fixture App / Send')
  assert.equal(proposal.description, 'Press “Send” in Fixture App')
  assert.deepEqual(
    proposal.arguments.path,
    [0, 2],
    'the approval did not bind the resolved control',
  )
  assert.equal(presses, 0, 'the control was pressed before it was approved')
  engine.decide(approval.id, 'approved', proposal.argumentHash)
  await until(() => engine.activeCount === 0, 'The press did not settle')
  assert.equal(db.store.getTask(task.id).state, 'paused')
  engine.control(task.id, 'resume')
  await until(() => engine.activeCount === 0, 'The resumed task did not finish')
  assert.equal(db.store.getTask(task.id).state, 'completed')
  assert.equal(presses, 1, 'the control was pressed again on resume')
  assert.equal(plans, 1, 'the resumed task asked the model to plan again')
  assert.match(db.store.receipts()[0].summary, /not pressed a second time/)
  await engine.shutdown()
  db.close()
})

test('a notes folder answers beside memory, and memory still answers on its own', async () => {
  const db = database()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-beside-')))
  writeFileSync(join(dir, 'gateway.md'), '# Gateway\n\nThe staging gateway listens on port 8443.\n')
  db.store.saveMemory(memory('The staging gateway belongs to the platform team.'))
  const vault = new VaultIndex(db.store, { records: [] } as unknown as Models, () => {})
  await vault.connect(dir)
  await vault.sync()
  // One question, two kinds of source: something remembered and something written down.
  assert.equal(db.store.searchMemory('staging gateway', 'personal').length, 1)
  assert.equal(db.store.searchNotes('staging gateway', 'personal').length, 1)
  assert.match(db.store.searchNotes('staging gateway', 'personal')[0].text, /8443/)
  vault.forget()
  assert.equal(db.store.searchNotes('staging gateway', 'personal').length, 0)
  assert.equal(
    db.store.searchMemory('staging gateway', 'personal').length,
    1,
    'forgetting the notes took memory with it',
  )
  vault.stop()
  rmSync(dir, { recursive: true, force: true })
  db.close()
})

test('a seen point is mapped onto a real control, and one that lands on nothing is refused', async () => {
  const controls = [
    {
      path: [1, 0],
      role: 'AXButton',
      label: 'Send',
      enabled: true,
      x: 500,
      y: 400,
      width: 80,
      height: 30,
    },
    {
      path: [1, 1],
      role: 'AXButton',
      label: 'Discard',
      enabled: true,
      x: 700,
      y: 400,
      width: 80,
      height: 30,
    },
  ]
  let deletes = 0
  // The captured area is half the area asked for, as a region clipped to a display would be.
  // Mapping through the requested width instead would put every point somewhere else entirely.
  const native = (async (method: string) => {
    if (method === 'context.region')
      return {
        imagePath: '/tmp/seen.jpg',
        width: 640,
        capturedX: 476,
        capturedY: 376,
        capturedWidth: 164,
      }
    if (method === 'ephemeral.delete') return ++deletes
    throw new Error(`unexpected ${method}`)
  }) as unknown as Parameters<typeof locateBySight>[0]
  const seeing = (point: number[]) =>
    ({ request: async () => ({ points: [point] }) }) as unknown as Models
  // (350, 150) in the image is (566, 414) on screen, inside Send. Through the requested width
  // it would be (655, 453), which is no control at all.
  const found = await locateBySight(native, seeing([350, 150]), 'Send', controls, [])
  assert.equal(found.label, 'Send')
  await assert.rejects(
    locateBySight(native, seeing([2000, 2000]), 'Send', controls, []),
    /not a control I can press/,
  )
  await assert.rejects(
    locateBySight(
      native,
      { request: async () => ({ points: [] }) } as unknown as Models,
      'Send',
      controls,
      [],
    ),
    /could not see anything/,
  )
  assert.equal(deletes, 3, 'a capture was left behind')
})

test('a model runtime that will not start says why, in words the interface can show', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-runtime-'))
  const workers = join(dir, 'workers')
  mkdirSync(workers)
  writeFileSync(
    join(workers, 'runtime.json'),
    JSON.stringify({ version: 1, python: 'interpreter' }),
  )
  // A runtime that fails the way a missing dependency would: a word on stderr, then gone.
  writeFileSync(
    join(workers, 'interpreter'),
    '#!/bin/sh\nsleep 0.5\necho "ModuleNotFoundError: No module named mlx" >&2\nexit 1\n',
    { mode: 0o755 },
  )
  writeFileSync(join(workers, 'models.py'), '')
  const models = new Models(
    dir,
    workers,
    () => {},
    () => {},
  )
  await assert.rejects(models.start())
  assert.match(models.failure ?? '', /ModuleNotFoundError: No module named mlx/)
  assert.equal(models.process, undefined, 'a dead runtime was left looking alive')
  rmSync(dir, { recursive: true, force: true })
})

test('a runtime that answers and then leaves quietly is reported, not treated as fine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-quiet-'))
  const workers = join(dir, 'workers')
  mkdirSync(workers)
  writeFileSync(
    join(workers, 'runtime.json'),
    JSON.stringify({ version: 1, python: 'interpreter' }),
  )
  // Answers the handshake, then ends on its own with a clean status and nothing on stderr.
  writeFileSync(
    join(workers, 'interpreter'),
    [
      '#!/bin/sh',
      'reply() {',
      '  read -r line || exit 0',
      '  id=$(printf "%s" "$line" | sed -n \'s/.*"id":"\\([^"]*\\)".*/\\1/p\')',
      '  printf \'{"version":1,"id":"%s","result":{"version":1,"roles":[]}}\\n\' "$id"',
      '}',
      'reply',
      'reply',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  )
  writeFileSync(join(workers, 'models.py'), '')
  const models = new Models(
    dir,
    workers,
    () => {},
    () => {},
  )
  assert.equal(await models.start(), true, 'the handshake did not complete')
  assert.equal(models.failure, undefined, 'a healthy handshake reported a failure')
  await until(() => models.failure !== undefined, 'a runtime that left on its own went unreported')
  assert.match(models.failure!, /stopped on its own \(exit 0\)/)
  assert.equal(models.process, undefined)
  rmSync(dir, { recursive: true, force: true })
})
