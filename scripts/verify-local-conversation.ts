import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/core/store'
import { Settings, type AppSnapshot } from '../src/shared/contracts'
import { JsonProcess } from '../src/core/process'
import { Models } from '../src/core/models'

// The real service, encrypted store, local models, native playback and file executor.
// Microphone input is silent and simulated; this does not measure human acoustic accuracy.
const installed = process.argv
  .find((argument) => argument.startsWith('--installed='))
  ?.slice('--installed='.length)
const resources = installed ? join(resolve(installed), 'Contents/Resources') : resolve('.')
const workersDir = join(resources, 'workers')
const nativePath = installed
  ? join(resources, 'native/JarvisNative')
  : resolve('native/build/JarvisNative')
const profile = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-local-conversation-')))
const modelSource = join(homedir(), 'Library/Application Support/Jarvis/models')
const project = join(profile, 'project')
mkdirSync(project)
for (const id of readdirSync(modelSource)) {
  if (!existsSync(join(modelSource, id, 'manifest.json'))) continue
  mkdirSync(join(profile, 'models', id), { recursive: true })
  copyFileSync(join(modelSource, id, 'manifest.json'), join(profile, 'models', id, 'manifest.json'))
  symlinkSync(join(modelSource, id, 'weights'), join(profile, 'models', id, 'weights'))
}
const key = randomBytes(32)
const seed = new Store(join(profile, 'jarvis.db'), key)
seed.setSetting(
  'preferences',
  Settings.parse({
    conversationEngine: 'pipeline',
    wakeWord: false,
    automaticEndpointing: true,
    handsFree: true,
    bargeIn: true,
    replyLength: 'brief',
    privacyMode: 'local-only',
  }),
)
seed.saveProject({
  id: 'voice-fixture',
  name: 'Voice fixture',
  path: project,
  trusted: true,
  checks: [],
  createdAt: new Date().toISOString(),
})
seed.setSetting('activeProjectId', 'voice-fixture')
seed.close()
const fixtures = new Map<string, { path: string; pcm: Buffer }>()
const fixtureModels = new Models(
  profile,
  workersDir,
  () => {},
  () => {},
)
try {
  await fixtureModels.start()
  const runtime = JSON.parse(readFileSync(join(workersDir, 'runtime.json'), 'utf8'))
  const directory = join(profile, 'fixtures')
  mkdirSync(directory)
  for (const text of ['Hey Friday.', 'Friday.', 'Hey Jarvis.', 'What is the capital of France?']) {
    const clip = await fixtureModels.request('tts', { text, voice: 'bm_george', speed: 1 })
    const path = join(directory, `${fixtures.size}.wav`)
    copyFileSync(clip.path, path)
    const pcm = path + '.pcm'
    execFileSync(join(workersDir, runtime.python), [
      '-c',
      [
        'import sys,numpy as np,soundfile as sf',
        'from scipy.signal import resample_poly',
        'from math import gcd',
        'a,r=sf.read(sys.argv[1],dtype="float32");g=gcd(r,16000)',
        'a=np.concatenate([np.zeros(6400),resample_poly(a,16000//g,r//g),np.zeros(16000)])',
        '(a*32767).astype(np.int16).tofile(sys.argv[2])',
      ].join('\n'),
      path,
      pcm,
    ])
    fixtures.set(text, { path, pcm: readFileSync(pcm) })
  }
} finally {
  fixtureModels.stop()
}
const native = new JsonProcess(nativePath, [profile])
const port = new EventEmitter() as EventEmitter & { postMessage: (message: any) => void }
;(process as any).parentPort = port
const send = (data: any) => port.emit('message', { data })
const pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void }>()
let snapshot: AppSnapshot | undefined
let captureGeneration = 0
let elapsed = 0
let inputOpen = false
let captureMode = 'off'
let inputQueue = Buffer.alloc(0)
let activeFixture: string | undefined
let playbackAt = 0
let requestedAt = 0
let shutdown = false
const cases: any[] = []
const notices: string[] = []
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
async function until(test: () => boolean, message: string, limit = 60_000) {
  const end = Date.now() + limit
  while (!test()) {
    assert.ok(Date.now() < end, message)
    await pause(50)
  }
}
async function host(method: string, params: any) {
  assert.equal(method, 'native', `Unexpected host request: ${method}`)
  const action = params.method
  const args = params.params ?? {}
  if (action === 'permissions' || action === 'permission.request')
    return { microphone: 'granted', screen: 'denied', accessibility: 'denied' }
  if (action === 'listen.start' || action === 'audio.start') {
    const preRoll = captureMode === 'watch' && action === 'audio.start' ? 1 : 0
    captureMode = action === 'listen.start' ? 'watch' : 'recording'
    captureGeneration = args.generation
    elapsed = 0
    inputOpen = true
    return {
      generation: captureGeneration,
      sampleRate: 16000,
      voiceProcessing: true,
      playbackCancelled: true,
      preRoll,
    }
  }
  if (action === 'audio.preview' || action === 'audio.stop') {
    assert.ok(activeFixture, 'No simulated speech fixture was supplied')
    const path = join(profile, 'ephemeral', `${randomUUID()}.wav`)
    copyFileSync(activeFixture, path)
    if (action === 'audio.stop') {
      inputOpen = false
      captureMode = 'off'
      inputQueue = Buffer.alloc(0)
    }
    return { path, generation: captureGeneration }
  }
  if (action === 'audio.discard' || action === 'listen.stop') {
    if (action === 'listen.stop' && captureMode === 'recording') return true
    inputOpen = false
    captureMode = 'off'
    return true
  }
  if (action === 'speech.enqueue' || action === 'speech.play') {
    const result = await native.request(action, args)
    if (!playbackAt) playbackAt = performance.now()
    return result
  }
  return native.request(action, args)
}
port.postMessage = (message) => {
  if (message.host)
    void host(message.host, message.params).then(
      (result) => send({ hostResponse: message.id, result }),
      (error) => send({ hostResponse: message.id, error: String(error) }),
    )
  else if (message.shutdownComplete) shutdown = true
  else if (message.event?.type === 'snapshot') snapshot = structuredClone(message.event.snapshot)
  else if (message.event?.type === 'notice') notices.push(message.event.message)
  else if (message.id && pending.has(message.id)) {
    const p = pending.get(message.id)!
    pending.delete(message.id)
    if (message.error) p.reject(new Error(message.error))
    else p.resolve(message.result)
  }
}
native.on('message', (message) => {
  if (message.method.startsWith('speech.')) send({ nativeEvent: message })
})
const silence = Buffer.alloc(1024).toString('base64')
const frameTimer = setInterval(() => {
  if (!inputOpen) return
  elapsed += 0.032
  const chunk = inputQueue.subarray(0, 1024)
  inputQueue = inputQueue.subarray(chunk.length)
  send({
    nativeEvent: {
      method: 'audio.level',
      params: {
        generation: captureGeneration,
        sampleRate: 16000,
        pcm: chunk.length ? chunk.toString('base64') : silence,
        level: chunk.length ? 0.08 : 0,
        elapsed,
      },
    },
  })
}, 32)
async function command(command: any) {
  const id = randomUUID()
  const result = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }))
  send({ id, command })
  return result
}
const report: any = {
  generatedAt: new Date().toISOString(),
  installedResources: installed ? resources : undefined,
  humanSpeechTested: false,
  scope:
    'Typed and synthesized speech through the current service, local models, native playback, memory and a scoped file effect. An installed path checks bundled workers and native helpers, not the installed UI. Microphone input simulated, not human acoustic qualification.',
  cases,
}
try {
  await import('../src/main/service-worker')
  send({
    init: {
      dataDir: profile,
      appPath: resolve('.'),
      resourcesPath: resources,
      packaged: !!installed,
      key: key.toString('base64'),
      nativeInfo: {
        permissions: { microphone: 'granted', screen: 'denied', accessibility: 'denied' },
      },
    },
  })
  key.fill(0)
  await until(
    () =>
      !!snapshot?.diagnostics.modelRuntime &&
      snapshot.models.some((m) => m.id === 'qwen' && m.qualified),
    'Local models did not start',
  )
  await until(
    () => readFileSync(join(profile, 'runtime.log'), 'utf8').includes('Warmed'),
    'Local models did not warm',
    120_000,
  )
  await pause(2500)
  const granted = await command({ type: 'permission.request', permission: 'microphone' })
  assert.equal(
    granted.microphone,
    'granted',
    'Permission result cannot enable natural conversation on its first click',
  )
  report.microphonePermissionResult = granted.microphone
  await command({ type: 'model.qualify', id: 'qwen' })
  await until(
    () => snapshot!.models.some((model) => model.id === 'qwen' && model.checking),
    'The running model check was not visible',
  )
  for (const [text, expected] of [
    ['What is two plus two?', /four|4/i],
    ['Double that number.', /eight|8/i],
    ['Remember that my test bicycle is blue.', /remember/i],
    ['What colour is my test bicycle?', /blue/i],
  ] as const) {
    if (snapshot!.voice.phase === 'listening')
      await command({ type: 'conversation.send', text: 'go to sleep' })
    playbackAt = 0
    requestedAt = performance.now()
    await command({ type: 'conversation.send', text })
    await until(() => playbackAt > 0, 'Reply did not reach native playback')
    const reply = snapshot!.messages.filter((m) => m.role === 'assistant').at(-1)!.text
    assert.match(reply, expected)
    const observed = { input: text, reply, firstPlaybackMs: Math.round(playbackAt - requestedAt) }
    cases.push(observed)
    console.log(JSON.stringify(observed))
    await until(
      () => ['off', 'listening'].includes(snapshot!.voice.phase),
      'Reply did not finish playing',
    )
    await pause(1500)
  }
  assert.equal(
    snapshot!.models.some((model) => model.checking),
    false,
  )
  assert.ok(
    notices.some((notice) => notice.includes('stopped so Jarvis can answer')),
    'The foreground question did not cancel the model benchmark',
  )
  report.foregroundCancelledModelCheck = true
  await command({ type: 'voice.toggle' })
  // A typed request can also steer an open voice session without turning follow-up listening off.
  await command({
    type: 'conversation.send',
    text: 'Create a file called voice-check.txt containing exactly "voice test passed".',
  })
  await until(
    () => !!snapshot!.approvals.find((a) => a.decision === 'pending'),
    'No concrete file approval arrived',
  )
  const approval = snapshot!.approvals.find((a) => a.decision === 'pending')!
  assert.equal(approval.proposal.tool, 'file.create')
  assert.equal(approval.proposal.target, join(project, 'voice-check.txt'))
  assert.equal(snapshot!.voice.handsFree, true, 'An action ended the hands-free conversation')
  await command({
    type: 'approval.decide',
    id: approval.id,
    decision: 'approved',
    argumentHash: approval.proposal.argumentHash,
  })
  await until(
    () => snapshot!.tasks.some((task) => task.state === 'completed'),
    'File action did not complete',
  )
  const contents = readFileSync(join(project, 'voice-check.txt'), 'utf8')
  assert.equal(contents, 'voice test passed')
  const task = snapshot!.tasks.find((t) => t.state === 'completed')!
  const receipt = snapshot!.receipts.find((r) => r.taskId === task.id)
  assert.ok(receipt)
  report.action = { objective: task.objective, contents, receipt }
  await command({ type: 'conversation.send', text: 'go to sleep' })
  await command({
    type: 'settings.update',
    patch: { wakeName: 'Friday', wakeWord: true, wakeOnName: true },
  })
  async function standby() {
    await until(
      () =>
        !!snapshot!.voice.watching &&
        snapshot!.voice.listener?.state === 'ready' &&
        snapshot!.voice.listener.detector === 'keyword',
      'The custom wake listener did not arm',
    )
  }
  function feed(text: string) {
    const fixture = fixtures.get(text)!
    activeFixture = fixture.path
    inputQueue = Buffer.from(fixture.pcm)
  }
  await standby()
  const noticesBeforeOldName = notices.length
  feed('Hey Jarvis.')
  await until(() => inputQueue.length === 0, 'Old-name fixture did not drain')
  await pause(1000)
  assert.equal(snapshot!.voice.phase, 'off', 'The old name opened a conversation')
  assert.equal(
    notices.slice(noticesBeforeOldName).some((n) => n.startsWith('Heard')),
    false,
  )
  const wakeChecks: any[] = []
  for (const text of ['Hey Friday.', 'Friday.']) {
    await standby()
    playbackAt = 0
    const priorNotices = notices.length
    feed(text)
    await until(
      () => notices.slice(priorNotices).some((n) => n.startsWith('Heard')),
      'The configured name did not wake',
    )
    await until(
      () => playbackAt > 0 && snapshot!.voice.phase === 'listening',
      'Name-only wake did not acknowledge and reopen for a question',
    )
    assert.equal(snapshot!.voice.handsFree, true)
    const previousMessages = snapshot!.messages.length
    feed('What is the capital of France?')
    await until(
      () =>
        snapshot!.messages
          .slice(previousMessages)
          .some((m) => m.role === 'assistant' && !m.streaming && /Paris/i.test(m.text)),
      'The spoken follow-up was not answered',
    )
    wakeChecks.push({
      input: text,
      nameAcknowledged: true,
      followup: snapshot!.messages.at(-1)!.text,
    })
    await command({ type: 'conversation.send', text: 'go to sleep' })
  }
  report.wakeChecks = wakeChecks
  const timings = readFileSync(join(profile, 'runtime.log'), 'utf8').split('\n')
    .filter((line) => line.includes('Voice model timing: '))
    .map((line) => JSON.parse(line.split('Voice model timing: ')[1]))
  assert.ok(timings[0]?.cachedTokens > 0, 'The prepared conversation prefix was not reused')
  assert.ok(timings[1]?.cachedTokens > timings[0].cachedTokens,
    'The prepared prefix did not grow to include the preceding exchange')
  report.preparedConversationTokens = timings.map(({ promptTokens, cachedTokens }) => ({ promptTokens, cachedTokens }))
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = String(error)
  process.exitCode = 1
} finally {
  clearInterval(frameTimer)
  send({ shutdown: true })
  await until(() => shutdown, 'Service did not shut down', 15_000).catch(() => {})
  native.stop()
  report.notices = notices
  if (existsSync(join(profile, 'runtime.log')))
    report.runtimeLog = readFileSync(join(profile, 'runtime.log'), 'utf8')
  writeFileSync('verification/local-conversation.json', JSON.stringify(report, null, 2) + '\n')
  rmSync(profile, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: report.passed, error: report.error }))
}
