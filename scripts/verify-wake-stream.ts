import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Models } from '../src/core/models'

const profile = resolve(process.argv[2] ?? join(homedir(), 'Library/Application Support/Jarvis'))
const temporary = mkdtempSync(join(tmpdir(), 'jarvis-wake-stream-'))
const runtime = JSON.parse(readFileSync('workers/runtime.json', 'utf8'))
let generation = 0
let ready = 0
let began = 0
let generating = false
let wakes: unknown[] = []
const errors: string[] = []
const models = new Models(
  profile,
  resolve('workers'),
  () => {},
  (message) => {
    if (message.method === 'listen.ready') ready = message.params.generation
    if (message.method === 'listen.error') errors.push(message.params.message)
    if (message.method === 'listen.wake' && message.params.generation === generation)
      wakes.push({
        ...message.params,
        elapsedMs: performance.now() - began,
        whileGenerating: generating,
      })
  },
)
const result: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  humanSpeechTested: false,
  scope:
    'Synthesized positive, negative and silence fixtures streamed as real-time 16 kHz microphone frames while Qwen generates. This measures listener independence, not live acoustic wake accuracy.',
  cases: [],
}
const clips: string[] = []
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  await models.start()
  for (const [label, text] of [
    ['name', 'Hey Jarvis.'],
    ['other speech', 'Good evening. Ready when you are.'],
  ] as const) {
    const rendered = await models.request('tts', { text, voice: 'bm_george', speed: 1 })
    clips.push(rendered.path)
    execFileSync(resolve('workers', runtime.python), [
      '-c',
      [
        'import sys, numpy as np, soundfile as sf',
        'from scipy.signal import resample_poly',
        'from math import gcd',
        'a, rate = sf.read(sys.argv[1], dtype="float32", always_2d=True)',
        'g = gcd(rate, 16000)',
        'a = resample_poly(a.mean(axis=1), 16000 // g, rate // g)',
        'a = np.concatenate([np.zeros(6400), a, np.zeros(16000)])',
        '(a * 32767).astype(np.int16).tofile(sys.argv[2])',
      ].join('\n'),
      rendered.path,
      join(temporary, label + '.pcm'),
    ])
  }
  writeFileSync(join(temporary, 'silence.pcm'), Buffer.alloc(16000 * 3 * 2))
  await models.warm(['reasoning'])
  for (const label of ['other speech', 'silence', 'name']) {
    generation++
    wakes = []
    models.notify('listen.configure', { generation, wake: true })
    const deadline = Date.now() + 10_000
    while (ready !== generation) {
      assert.ok(Date.now() < deadline, 'Listener did not arm')
      await pause(10)
    }
    const controller = new AbortController()
    generating = true
    const work = models
      .request(
        'chat',
        {
          messages: [
            {
              role: 'user',
              content:
                'Write a long detailed essay explaining each of the first fifty prime numbers. Keep writing until all fifty are covered.',
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
    began = performance.now()
    const bytes = readFileSync(join(temporary, label + '.pcm'))
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      const chunk = bytes.subarray(offset, offset + 1024)
      const elapsed = (offset + chunk.length) / 32000
      models.notify('audio.frame', { generation, elapsed, pcm: chunk.toString('base64') })
      const remaining = began + elapsed * 1000 - performance.now()
      if (remaining > 0) await pause(remaining)
    }
    await pause(200)
    const observed = { label, wakes: [...wakes], stillGenerating: generating }
    ;(result.cases as unknown[]).push(observed)
    console.log(JSON.stringify(observed))
    controller.abort()
    await work
    if (label === 'name') {
      assert.equal(
        wakes.length,
        1,
        'The streamed name must wake exactly once per microphone generation',
      )
      assert.equal((wakes[0] as any).whileGenerating, true, 'Wake waited behind generation')
    } else assert.equal(wakes.length, 0, 'A negative fixture woke the listener')
  }
  assert.equal(errors.length, 0, errors.join('; '))
  result.passed = true
} catch (error) {
  result.passed = false
  result.error = String(error)
  process.exitCode = 1
} finally {
  models.stop()
  clips.forEach((path) => rmSync(path, { force: true }))
  rmSync(temporary, { recursive: true, force: true })
  writeFileSync('verification/wake-stream.json', JSON.stringify(result, null, 2) + '\n')
}
