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
import { spawnSync } from 'node:child_process'
import { spoken, firstSentence, engineReady, engineInUse, DUPLEX_MODEL } from '../src/shared/speech'
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
import {
  HANDS_FREE_PATIENCE_SECONDS,
  TURN_LIMIT_SECONDS,
  endpointingReady,
  handsFreeReady,
  shouldReopenMicrophone,
  turnAction,
  withVoiceDependencies,
  type ListeningTurn,
  type ResumeContext,
  WAKE_MODEL,
  SPEECH_LEVEL,
  NAME_GAP_SECONDS,
  NAME_MAX_SECONDS,
  NAME_MIN_SECONDS,
  isNameSpoken,
  nameWakeReady,
  shouldTranscribeForName,
  type SpokenBurst,
  bargeInReady,
  isInterruption,
  shouldScoreWake,
  shouldWatchForWake,
  wakeReady,
  withListeningDependencies,
  type PlaybackListen,
  type WakeScoring,
  type WakeWatch,
} from '../src/shared/turn'
import { replyChoices, replyShape, spokenInstruction, type ReplyLength } from '../src/shared/reply'

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

test('an engine is offered only where what it needs has been observed working', () => {
  const nothing = () => false
  const all = () => true
  // The separate models are always there; they are what everything else falls back to.
  assert.equal(engineReady('pipeline', nothing, nothing), true)
  assert.equal(engineReady('duplex', nothing, all), false, 'an unqualified model was offered')
  assert.equal(
    engineReady('duplex', (id) => id === DUPLEX_MODEL, nothing),
    true,
  )
  assert.equal(
    engineReady('realtime', all, nothing),
    false,
    'a cloud engine was offered unconnected',
  )
  assert.equal(
    engineReady('realtime', nothing, (id) => id === 'openai-realtime'),
    true,
  )
})

test('an engine that is not ready falls back to local, never to the cloud', () => {
  const nothing = () => false
  // A chosen engine whose model was removed must not quietly start sending audio to OpenAI.
  assert.equal(
    engineInUse('duplex', nothing, () => true),
    'pipeline',
  )
  assert.equal(engineInUse('realtime', nothing, nothing), 'pipeline')
  assert.equal(
    engineInUse('duplex', (id) => id === DUPLEX_MODEL, nothing),
    'duplex',
  )
  assert.equal(
    engineInUse('realtime', nothing, (id) => id === 'openai-realtime'),
    'realtime',
  )
})

test('what is spoken is the words, not the marks that were meant for the eye', () => {
  assert.equal(spoken('The capital is **Paris**.'), 'The capital is Paris.')
  assert.equal(spoken('## Heading\n- one\n- two'), 'Heading\none\ntwo')
  assert.equal(spoken('See [the note](https://example.com/x) for more.'), 'See the note for more.')
  assert.equal(spoken('Run `pnpm test` now.'), 'Run pnpm test now.')
  assert.equal(spoken('Before\n```js\nconst a = 1\n```\nAfter'), 'Before\n(code)\nAfter')
  assert.equal(spoken('_emphasis_ and ~~struck~~'), 'emphasis and struck')
  // A word with underscores inside it is a name, not emphasis.
  assert.equal(spoken('The file is af_heart today.'), 'The file is af_heart today.')
})

test('a sentence is only handed to the voice once it has actually finished', () => {
  assert.equal(
    firstSentence('The capital of France'),
    undefined,
    'an unfinished thought was spoken',
  )
  assert.deepEqual(firstSentence('It is Paris. And then'), ['It is Paris.', ' And then'])
  assert.deepEqual(firstSentence('Really? Yes'), ['Really?', ' Yes'])
  // 3.85 is a number, not two sentences.
  assert.equal(firstSentence('It took 3.85 seconds'), undefined, 'a decimal point ended a sentence')
  assert.deepEqual(firstSentence('It took 3.85 seconds. Next'), ['It took 3.85 seconds.', ' Next'])
  assert.deepEqual(firstSentence('He said "go." Then left'), ['He said "go."', ' Then left'])
})

test('a long profile path does not send speech to a directory that is not there', (t) => {
  // espeak-ng holds its data directory in a 160-byte buffer. Handed a longer path it silently uses
  // the one compiled into the wheel and then exits the process, so the rule is worth pinning: the
  // bundled directory is used when it fits, and reached through a short link when it does not.
  const python = spawnSync('python3', ['-c', 'pass'])
  if (python.error) return t.skip('python3 is not on PATH')
  const source = readFileSync('workers/models.py', 'utf8')
  const rule = source.slice(
    source.indexOf('ESPEAK_PATH_LIMIT ='),
    source.indexOf('def prepare_espeak('),
  )
  assert.ok(rule.includes('def espeak_data_path'), 'the espeak path rule was not found to test')
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-espeak-'))
  const short = join(dir, 'espeak-ng-data')
  const deep = join(dir, 'd'.repeat(120), 'espeakng_loader', 'espeak-ng-data')
  mkdirSync(short)
  mkdirSync(deep, { recursive: true })
  assert.ok(short.length < 160 && deep.length >= 160, 'the fixture paths do not straddle the limit')
  const run = (data: string, root: string) =>
    spawnSync(
      'python3',
      [
        '-c',
        [
          'import sys, types',
          'from pathlib import Path',
          `ROOT = Path(${JSON.stringify(root)})`,
          'loader = types.ModuleType("espeakng_loader")',
          `loader.get_data_path = lambda: ${JSON.stringify(data)}`,
          'sys.modules["espeakng_loader"] = loader',
          rule,
          'print(espeak_data_path())',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    )
  const fits = run(short, dir)
  assert.equal(fits.status, 0, fits.stderr)
  assert.equal(fits.stdout.trim(), short, 'a directory that fits was not used as it stands')
  const roomFor = mkdtempSync(join(tmpdir(), 'jarvis-root-'))
  const long = run(deep, roomFor)
  assert.equal(long.status, 0, long.stderr)
  const chosen = long.stdout.trim()
  assert.notEqual(chosen, deep, 'a directory too long for espeak was handed over unchanged')
  assert.ok(chosen.length < 160, `the link is itself too long: ${chosen.length} bytes`)
  assert.equal(realpathSync(chosen), realpathSync(deep), 'the link does not reach the real data')
  rmSync(dir, { recursive: true, force: true })
  rmSync(roomFor, { recursive: true, force: true })
})

test('a runtime that is slow to answer is asked again, not killed for being slow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-slow-'))
  const workers = join(dir, 'workers')
  mkdirSync(workers)
  writeFileSync(
    join(workers, 'runtime.json'),
    JSON.stringify({ version: 1, python: 'interpreter' }),
  )
  // Ignores the first request outright, the way a cold worker still importing would, then answers.
  writeFileSync(
    join(workers, 'interpreter'),
    [
      '#!/bin/sh',
      'first=1',
      'while read -r line; do',
      '  case "$line" in *\'"id":\'*) ;; *) continue ;; esac',
      '  if [ $first = 1 ]; then first=0; continue; fi',
      '  id=$(printf "%s" "$line" | sed -n \'s/.*"id":"\\([^"]*\\)".*/\\1/p\')',
      '  printf \'{"version":1,"id":"%s","result":{"version":1,"roles":["asr"]}}\\n\' "$id"',
      'done',
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
  models.patience = 400
  assert.equal(await models.start(), true, 'a worker that answered the second ping was given up on')
  assert.equal(models.failure, undefined, 'being slow was reported as a failure')
  assert.ok(models.process, 'a living worker was killed for being slow to answer')
  const log = readFileSync(join(dir, 'runtime.log'), 'utf8')
  assert.match(log, /First ping went unanswered/, 'the retry left no record to read back')
  assert.match(log, /The runtime answered in /, 'first contact was not timed in the log')
  models.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('a runtime killed outright is named by its signal, not by an exit code it never had', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-killed-'))
  const workers = join(dir, 'workers')
  mkdirSync(workers)
  writeFileSync(
    join(workers, 'runtime.json'),
    JSON.stringify({ version: 1, python: 'interpreter' }),
  )
  // Answers the handshake, then waits to be killed the way the kernel kills a bad signature.
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
      'while true; do sleep 1; done',
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
  assert.equal(await models.start(), true)
  assert.equal(models.failure, undefined)
  process.kill(models.process!.child.pid!, 'SIGKILL')
  await until(() => models.failure !== undefined, 'a killed runtime went unreported')
  assert.match(models.failure!, /stopped on its own \(SIGKILL\)/)
  assert.equal(models.process, undefined)
  rmSync(dir, { recursive: true, force: true })
})

test('a spoken turn ends on a judged pause, on the recording limit, or on nobody speaking', () => {
  const turn = (over: Partial<ListeningTurn>): ListeningTurn => ({
    elapsed: 1,
    lastSpeechAt: 0,
    lastEndpointAt: 0,
    endpointing: false,
    handsFree: false,
    ...over,
  })
  // Without endpointing a turn only ends when the person says so, or at the recording limit.
  assert.equal(turnAction(turn({ elapsed: 40, lastSpeechAt: 30 })), 'wait')
  assert.equal(turnAction(turn({ elapsed: TURN_LIMIT_SECONDS, lastSpeechAt: 30 })), 'finish')
  assert.equal(turnAction(turn({ elapsed: TURN_LIMIT_SECONDS - 0.1, lastSpeechAt: 30 })), 'wait')
  // Endpointing examines a pause, and only after somebody has actually spoken.
  assert.equal(turnAction(turn({ elapsed: 9, lastSpeechAt: 0, endpointing: true })), 'wait')
  assert.equal(turnAction(turn({ elapsed: 4.1, lastSpeechAt: 3, endpointing: true })), 'wait')
  assert.equal(turnAction(turn({ elapsed: 4.2, lastSpeechAt: 3, endpointing: true })), 'examine')
  // One examination at a time: the next waits out the same pause again.
  assert.equal(
    turnAction(turn({ elapsed: 4.5, lastSpeechAt: 3, lastEndpointAt: 4.2, endpointing: true })),
    'wait',
  )
  assert.equal(
    turnAction(turn({ elapsed: 5.4, lastSpeechAt: 3, lastEndpointAt: 4.2, endpointing: true })),
    'examine',
  )
  // A hands-free microphone opens on its own, so an unanswered one closes on its own.
  assert.equal(
    turnAction(turn({ elapsed: HANDS_FREE_PATIENCE_SECONDS - 0.1, handsFree: true })),
    'wait',
  )
  assert.equal(
    turnAction(turn({ elapsed: HANDS_FREE_PATIENCE_SECONDS, handsFree: true })),
    'abandon',
  )
  // Having heard something, it waits for the endpointer like any other turn.
  assert.equal(
    turnAction(turn({ elapsed: 30, lastSpeechAt: 2, handsFree: true, endpointing: true })),
    'examine',
  )
  // A microphone the person opened themselves is left alone until the recording limit.
  assert.equal(turnAction(turn({ elapsed: 60, handsFree: false })), 'wait')
})

test('hands-free needs qualified endpointing, and never outlives it', () => {
  const qualified =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id)
  assert.equal(endpointingReady(qualified('silero', 'smart-turn')), true)
  // Smart Turn is installed but unqualified on this Mac, which is the whole point of the gate.
  assert.equal(endpointingReady(qualified('silero')), false)
  assert.equal(endpointingReady(qualified()), false)
  const on = { automaticEndpointing: true, handsFree: true }
  assert.equal(handsFreeReady(on, qualified('silero', 'smart-turn')), true)
  assert.equal(handsFreeReady(on, qualified('silero')), false)
  assert.equal(
    handsFreeReady({ automaticEndpointing: false }, qualified('silero', 'smart-turn')),
    false,
  )
  // Switching endpointing off takes hands-free with it, in the same write.
  assert.deepEqual(withVoiceDependencies(on), on)
  assert.deepEqual(withVoiceDependencies({ automaticEndpointing: false, handsFree: true }), {
    automaticEndpointing: false,
    handsFree: false,
  })
  // Unrelated settings travel through untouched.
  assert.deepEqual(withVoiceDependencies({ ...on, voiceSpeed: 1.2 }), { ...on, voiceSpeed: 1.2 })
})

test('the microphone reopens only for a live hands-free session that is not otherwise engaged', () => {
  const both = (id: string) => ['silero', 'smart-turn'].includes(id)
  const context = (over: Partial<ResumeContext> = {}): ResumeContext => ({
    handsFree: true,
    phase: 'off',
    locked: false,
    closing: false,
    automaticEndpointing: true,
    qualified: both,
    ...over,
  })
  assert.equal(shouldReopenMicrophone(context()), true)
  assert.equal(shouldReopenMicrophone(context({ handsFree: false })), false)
  // Never on top of speech, thought, or a turn already open: hands-free stays half duplex.
  for (const phase of ['listening', 'transcribing', 'thinking', 'speaking', 'error'] as const)
    assert.equal(shouldReopenMicrophone(context({ phase })), false)
  assert.equal(shouldReopenMicrophone(context({ locked: true })), false)
  assert.equal(shouldReopenMicrophone(context({ closing: true })), false)
  assert.equal(shouldReopenMicrophone(context({ automaticEndpointing: false })), false)
  // A model removed mid-session closes the loop rather than leaving a microphone nothing ends.
  assert.equal(shouldReopenMicrophone(context({ qualified: (id) => id === 'silero' })), false)
})

test('reply length carries a ceiling, because an instruction alone drifts', () => {
  const brief = replyShape('brief')
  const measured = replyShape('measured')
  const full = replyShape('full')
  // Shorter is shorter in both halves, or the setting only appears to do something.
  assert.ok(brief.maxTokens < measured.maxTokens)
  assert.ok(measured.maxTokens < full.maxTokens)
  assert.match(brief.instruction, /one short sentence/i)
  // The longest length asks for nothing and relies on the ceiling alone.
  assert.equal(full.instruction, '')
  // An unknown stored value must not strip the ceiling off a reply.
  assert.deepEqual(replyShape('elaborate' as ReplyLength), measured)
  assert.deepEqual(
    replyChoices().map((c) => c.id),
    ['brief', 'measured', 'full'],
  )
  // Spoken replies add their own constraint rather than replacing the chosen length.
  assert.match(spokenInstruction(), /no markdown/i)
  assert.equal(Settings.parse({}).replyLength, 'measured')
})

test('the microphone listens for the name only when nobody is taking a turn', () => {
  const watch = (over: Partial<WakeWatch> = {}): WakeWatch => ({
    wakeWord: true,
    phase: 'off',
    locked: false,
    closing: false,
    bargeIn: false,
    ...over,
  })
  assert.equal(shouldWatchForWake(watch()), true)
  // An error left the orb idle; it should still answer to its name.
  assert.equal(shouldWatchForWake(watch({ phase: 'error' })), true)
  assert.equal(shouldWatchForWake(watch({ wakeWord: false })), false)
  // Never behind a turn the person already started.
  for (const phase of ['listening', 'transcribing', 'thinking'] as const)
    assert.equal(shouldWatchForWake(watch({ phase })), false)
  assert.equal(shouldWatchForWake(watch({ locked: true })), false)
  assert.equal(shouldWatchForWake(watch({ closing: true })), false)
  // While speaking, the microphone is open only to be interrupted, and only if allowed.
  assert.equal(shouldWatchForWake(watch({ phase: 'speaking' })), false)
  assert.equal(shouldWatchForWake(watch({ phase: 'speaking', bargeIn: true })), true)
  // Interrupting is its own permission: it does not need the name switched on.
  assert.equal(
    shouldWatchForWake(watch({ phase: 'speaking', wakeWord: false, bargeIn: true })),
    true,
  )
})

test('an idle room never reaches the wake model, and echo never counts as an interruption', () => {
  // Scoring follows speech, and lingers so a name finishing in silence is still in the buffer.
  const score = (over: Partial<WakeScoring>) =>
    shouldScoreWake({ level: 0, quietSeconds: 10, sinceScoredMs: 1000, ...over })
  assert.equal(score({ level: SPEECH_LEVEL }), true)
  assert.equal(score({ level: 0, quietSeconds: 0.5 }), true)
  assert.equal(score({ level: 0, quietSeconds: 10 }), false)
  // Never faster than the interval, however loud the room is.
  assert.equal(score({ level: 1, sinceScoredMs: 10 }), false)

  const heard = (over: Partial<PlaybackListen>) =>
    isInterruption({ speechSeconds: 1, elapsed: 5, level: 0.9, playbackLevel: 0.2, ...over })
  assert.equal(heard({}), true)
  // Residual echo tracks the reply, so a microphone that merely matches it is not believed.
  assert.equal(heard({ level: 0.09, playbackLevel: 0.9 }), false)
  assert.equal(heard({ level: 0.6, playbackLevel: 0.9 }), true)
  // One frame over the line is the shape echo takes.
  assert.equal(heard({ speechSeconds: 0.1 }), false)
  // Silence is not an interruption however quiet the reply is.
  assert.equal(heard({ level: 0.01, playbackLevel: 0 }), false)
  // The start of playback is the worst moment for echo, so it is not listened through.
  assert.equal(heard({ elapsed: 0.1 }), false)
})

test('waking and interrupting are cleared when the model behind them goes', () => {
  const both = (id: string) => ['silero', 'smart-turn', 'parakeet', WAKE_MODEL].includes(id)
  const on = {
    wakeWord: true,
    wakeOnName: true,
    bargeIn: true,
    automaticEndpointing: true,
    handsFree: true,
  }
  assert.equal(wakeReady(both), true)
  assert.equal(bargeInReady(both), true)
  assert.deepEqual(withListeningDependencies(on, both), on)
  // Losing the wake model takes waking with it and leaves the rest standing.
  assert.deepEqual(
    withListeningDependencies(on, (id) => id !== WAKE_MODEL),
    // The bare name is heard by the microphone the phrase holds open, so it goes too.
    { ...on, wakeWord: false, wakeOnName: false },
  )
  // Losing Silero takes both interrupting and, through endpointing, hands-free.
  assert.deepEqual(
    withListeningDependencies(on, (id) => id === WAKE_MODEL),
    // Nothing left that can transcribe, so the bare name goes with the interruption.
    {
      wakeWord: true,
      wakeOnName: false,
      bargeIn: false,
      automaticEndpointing: true,
      handsFree: true,
    },
  )
  // Switching endpointing off still clears hands-free, and leaves waking alone.
  assert.deepEqual(withListeningDependencies({ ...on, automaticEndpointing: false }, both), {
    wakeWord: true,
    wakeOnName: true,
    bargeIn: true,
    automaticEndpointing: false,
    handsFree: false,
  })
  // The bare name cannot stand without the phrase that holds the microphone open.
  assert.equal(withListeningDependencies({ ...on, wakeWord: false }, both).wakeOnName, false)
})

test('the bare name is read from short bursts only, and read strictly', () => {
  // The length gate is the privacy boundary: outside it nothing is transcribed at all.
  const burst = (over: Partial<SpokenBurst> = {}) =>
    shouldTranscribeForName({ burstSeconds: 0.7, quietSeconds: 0.5, busy: false, ...over })
  assert.equal(burst(), true)
  assert.equal(burst({ burstSeconds: NAME_MIN_SECONDS }), true)
  assert.equal(burst({ burstSeconds: NAME_MAX_SECONDS }), true)
  // A cough is not a word; a sentence is somebody's conversation.
  assert.equal(burst({ burstSeconds: NAME_MIN_SECONDS - 0.01 }), false)
  assert.equal(burst({ burstSeconds: NAME_MAX_SECONDS + 0.01 }), false)
  assert.equal(burst({ burstSeconds: 8 }), false)
  // A pause mid-word is not the end of the burst.
  assert.equal(burst({ quietSeconds: NAME_GAP_SECONDS - 0.01 }), false)
  // One transcription at a time.
  assert.equal(burst({ busy: true }), false)

  // What counts as being called.
  for (const said of ['Jarvis', 'jarvis.', 'Jarvis!', 'Jarvis?', 'Hey Jarvis', 'hey, jarvis.'])
    assert.equal(isNameSpoken(said), true, said)
  // Near misses, and anything that is a request rather than a name.
  for (const said of [
    'Travis',
    'Hey Travis',
    'Service',
    'Jarvis, what is the weather',
    'tell Jarvis',
    '',
    'is that Jarvis',
  ])
    assert.equal(isNameSpoken(said), false, said)
  // Whitespace around a transcript should not decide whether Jarvis answers.
  assert.equal(isNameSpoken('  Jarvis.  '), true)
  assert.equal(
    nameWakeReady((id) => id === 'whisper'),
    true,
  )
  assert.equal(
    nameWakeReady((id) => id === 'kokoro'),
    false,
  )
})
