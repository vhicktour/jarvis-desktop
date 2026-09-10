import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Models } from '../src/core/models'
import { JsonProcess } from '../src/core/process'
import { Store } from '../src/core/store'
import { TaskEngine } from '../src/core/tasks'
import { localExecutor } from '../src/core/local-task'
import { Settings } from '../src/shared/contracts'

const data = resolve(process.argv[2] ?? '/tmp/jarvis-native-qa')
const directory = mkdtempSync('/tmp/jarvis-spoken-fixture-')
const native = new JsonProcess(resolve('native/build/JarvisNative'), [data])
const models = new Models(
  data,
  resolve('workers'),
  () => {},
  () => {},
)
const store = new Store(join(directory, 'ledger.db'), randomBytes(32))
const project = {
  id: 'fixture',
  name: 'Spoken fixture',
  path: join(directory, 'repository'),
  trusted: true,
  checks: [],
  createdAt: new Date().toISOString(),
}
mkdirSync(project.path)
store.saveProject(project)
const approved = new Set<string>()
let fixtureError: Error | undefined
const engine = new TaskEngine(
  store,
  localExecutor(models, (method, params) => native.request(method, params)),
  () => {
    queueMicrotask(() => {
      for (const approval of store.approvals()) {
        if (approved.has(approval.id)) continue
        if (
          approval.proposal.tool !== 'file.create' ||
          approval.proposal.target !== join(realpathSync(project.path), 'receipt.txt')
        ) {
          fixtureError = new Error(
            `Fixture attempted an unexpected effect: ${approval.proposal.tool} at ${approval.proposal.target}`,
          )
          engine.decide(approval.id, 'denied', approval.proposal.argumentHash)
          continue
        }
        approved.add(approval.id)
        console.log(
          JSON.stringify({
            event: 'fixture_approval',
            tool: approval.proposal.tool,
            arguments: approval.proposal.arguments,
          }),
        )
        engine.decide(approval.id, 'approved', approval.proposal.argumentHash)
      }
    })
  },
)
try {
  await native.request('ping')
  await models.start()
  const start = performance.now()
  const text = 'Create a file named receipt.txt containing exactly: A quietly capable companion.'
  const audio = await models.request('tts', { text, voice: 'bm_george', speed: 1 })
  const transcript = await models.request('asr', { path: audio.path, model: 'parakeet' })
  console.log(JSON.stringify({ event: 'transcribed', text: transcript.text }))
  const task = engine.create(transcript.text, 'local', project, Settings.parse({}).budget)
  const deadline = Date.now() + 180_000
  while (
    engine.activeCount ||
    !['completed', 'failed', 'needs_reconciliation'].includes(store.getTask(task.id).state)
  ) {
    if (Date.now() > deadline) throw new Error('Spoken fixture timed out.')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const receipt = store.receipts()[0]
  const result = {
    generatedAt: new Date().toISOString(),
    kind: 'synthesized-audio-fixture',
    microphoneRouteTested: false,
    input: text,
    transcript: transcript.text,
    elapsedSeconds: (performance.now() - start) / 1000,
    task: store.getTask(task.id),
    receipt,
    files: store.getTask(task.id).evidence.filter((e) => e.kind === 'file'),
    models: models.records
      .filter((m) => m.status === 'installed')
      .map((m) => ({ id: m.id, revision: m.revision })),
  }
  mkdirSync('verification', { recursive: true })
  writeFileSync('verification/spoken-task.json', JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      event: 'finished',
      state: result.task.state,
      elapsedSeconds: result.elapsedSeconds,
      evidence: result.files,
    }),
  )
  if (result.task.state !== 'completed') process.exitCode = 1
  if (fixtureError) console.error(fixtureError.message)
  await native.request('ephemeral.delete', { path: audio.path })
} finally {
  await engine.shutdown()
  models.stop()
  native.stop()
  store.close()
}
