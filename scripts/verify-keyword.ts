import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Models } from '../src/core/models'
import { addressedText } from '../src/shared/intent'

const profile = join(homedir(), 'Library/Application Support/Jarvis')
const temporary = mkdtempSync(join(tmpdir(), 'jarvis-keyword-'))
const runtime = JSON.parse(readFileSync('workers/runtime.json', 'utf8'))
let ready = 0
let generation = 0
let wakes: any[] = []
let health: any
let began = 0
let generating = false
const errors: string[] = []
const paths: string[] = []
const models = new Models(
  profile,
  resolve('workers'),
  () => {},
  (message) => {
    if (message.params?.generation !== generation) return
    if (message.method === 'listen.ready') ready = generation
    if (message.method === 'listen.status') health = message.params
    if (message.method === 'listen.error') errors.push(message.params.message)
    if (message.method === 'listen.wake')
      wakes.push({
        ...message.params,
        elapsedMs: performance.now() - began,
        whileGenerating: generating,
      })
  },
)
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const report: any = {
  generatedAt: new Date().toISOString(),
  humanSpeechTested: false,
  scope:
    'Generated phrases streamed through the real listener, including a custom name, bare-name confirmation with Whisper, a confusing negative, disabled bare wake, and keyword detection during Qwen generation.',
  cases: [],
}
try {
  await models.start()
  assert.equal(models.qualified('keyword'), true)
  const fixtures: Record<string, { path: string; pcm: Buffer }> = {}
  for (const text of [
    'Hey Jarvis.',
    'Jarvis.',
    'Hey Friday.',
    'Friday.',
    'Your service.',
    'What is the capital of France?',
  ]) {
    const result = await models.request('tts', {
      text,
      voice: text === 'Your service.' ? 'af_heart' : 'bm_george',
      speed: 1,
    })
    paths.push(result.path)
    const pcm = join(temporary, `${Object.keys(fixtures).length}.pcm`)
    execFileSync(resolve('workers', runtime.python), [
      '-c',
      [
        'import sys,numpy as np,soundfile as sf',
        'from scipy.signal import resample_poly',
        'from math import gcd',
        'a,r=sf.read(sys.argv[1],dtype="float32");g=gcd(r,16000)',
        'a=np.concatenate([np.zeros(6400),resample_poly(a,16000//g,r//g),np.zeros(16000)])',
        '(a*32767).astype(np.int16).tofile(sys.argv[2])',
      ].join('\n'),
      result.path,
      pcm,
    ])
    fixtures[text] = { path: result.path, pcm: readFileSync(pcm) }
  }
  await models.warm(['asr', 'reasoning'])
  for (const [name, text, bare, expected, load] of [
    ['Jarvis', 'Hey Jarvis.', true, true, false],
    ['Jarvis', 'Jarvis.', true, true, false],
    ['Friday', 'Hey Friday.', true, true, true],
    ['Friday', 'Friday.', true, true, false],
    ['Friday', 'Hey Jarvis.', true, false, false],
    ['Friday', 'Jarvis.', true, false, false],
    ['Jarvis', 'Jarvis.', false, false, false],
    ['Jarvis', 'Your service.', true, false, false],
    ['Jarvis', 'What is the capital of France?', true, false, false],
  ] as const) {
    generation++
    wakes = []
    health = undefined
    models.notify('listen.configure', { generation, wake: true, keyword: true, name, bare })
    const deadline = Date.now() + 10_000
    while (ready !== generation) {
      assert.ok(Date.now() < deadline)
      await pause(10)
    }
    const controller = new AbortController()
    generating = load
    const work = load
      ? models
          .request(
            'chat',
            {
              messages: [
                {
                  role: 'user',
                  content: 'Describe the first fifty prime numbers in great detail.',
                },
              ],
              maxTokens: 1000,
            },
            controller.signal,
          )
          .catch((error) => {
            if (!controller.signal.aborted) throw error
          })
          .finally(() => {
            generating = false
          })
      : Promise.resolve()
    began = performance.now()
    const bytes = fixtures[text].pcm
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      const chunk = bytes.subarray(offset, offset + 1024)
      const elapsed = (offset + chunk.length) / 32000
      models.notify('audio.frame', { generation, elapsed, pcm: chunk.toString('base64') })
      const remaining = began + elapsed * 1000 - performance.now()
      if (remaining > 0) await pause(remaining)
    }
    await pause(200)
    controller.abort()
    await work
    assert.ok(health?.frames > 0 && health.droppedFrames === 0, 'The listener lost audio frames')
    assert.ok(wakes.length <= 1, 'A name woke twice before re-arming')
    let confirmed = wakes.length === 1
    let transcript: string | undefined
    if (confirmed && wakes[0].nameOnly) {
      transcript = (
        await models.request('asr', {
          path: fixtures[text].path,
          model: 'whisper',
          prompt: `Hey ${name}. ${name}.`,
        })
      ).text.trim()
      confirmed = !!transcript && addressedText(transcript, name) !== transcript
    }
    const observed = { name, text, bare, expected, confirmed, transcript, wakes, health }
    report.cases.push(observed)
    console.log(JSON.stringify(observed))
    assert.equal(confirmed, expected, `${name}: ${text}`)
    if (load) assert.equal(wakes[0].whileGenerating, true, 'Wake was blocked behind generation')
  }
  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = String(error)
  process.exitCode = 1
} finally {
  models.stop()
  paths.forEach((path) => rmSync(path, { force: true }))
  rmSync(temporary, { recursive: true, force: true })
  writeFileSync('verification/keyword.json', JSON.stringify(report, null, 2) + '\n')
}
