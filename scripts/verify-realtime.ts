import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Models } from '../src/core/models'
import { JsonProcess } from '../src/core/process'
import { RealtimeVoice, REALTIME_MODEL } from '../src/providers/realtime'

// Explicit live check: fixed synthesized inputs only. The signed credential broker keeps the
// key in process memory; neither credentials nor microphone input enter the evidence artifact.
const resources = join(homedir(), 'Applications/Jarvis.app/Contents/Resources')
const profile = join(homedir(), 'Library/Application Support/Jarvis')
const directory = resolve('verification/private/realtime-fixtures')
const prompts = [
  'What is two plus two?',
  'Count slowly from one to thirty.',
  'Actually, what is the capital of France?',
  'Use your task status tool to check whether I have any active tasks.',
]
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
if (process.argv.includes('--prepare')) {
  mkdirSync(directory, { recursive: true })
  const workers = join(resources, 'workers')
  const runtime = JSON.parse(readFileSync(join(workers, 'runtime.json'), 'utf8'))
  const models = new Models(
    profile,
    workers,
    () => {},
    () => {},
  )
  const clips: string[] = []
  try {
    await models.start()
    const bounds: { prompt: string; voiceEndMs: number }[] = []
    for (const [index, text] of prompts.entries()) {
      const clip = await models.request('tts', { text, voice: 'bm_george', speed: 1 })
      clips.push(clip.path)
      const end = execFileSync(join(workers, runtime.python), [
        '-c',
        [
          'import sys, numpy as np, soundfile as sf',
          'from scipy.signal import resample_poly',
          'from math import gcd',
          'a, rate = sf.read(sys.argv[1], dtype="float32", always_2d=True)',
          'g = gcd(rate, 24000)',
          'a = resample_poly(a.mean(axis=1), 24000 // g, rate // g)',
          'a = np.concatenate([np.zeros(7200), a])',
          '(np.clip(a, -1, 1) * 32767).astype("<i2").tofile(sys.argv[2])',
          'print(np.flatnonzero(np.abs(a) > 0.02)[-1] / 24)',
        ].join('\n'),
        clip.path,
        join(directory, `${index}.pcm`),
      ])
      bounds.push({ prompt: text, voiceEndMs: Number(end.toString()) })
    }
    writeFileSync(join(directory, 'inputs.json'), JSON.stringify(bounds, null, 2) + '\n')
    console.log('Prepared four fixed local speech fixtures. No cloud request made.')
  } finally {
    models.stop()
    clips.forEach((path) => rmSync(path, { force: true }))
  }
  process.exit(0)
}

const maxCostUsd = Number(
  process.argv.find((arg) => arg.startsWith('--max-cost-usd='))?.split('=')[1],
)
assert.ok(
  maxCostUsd > 0 && maxCostUsd <= 1,
  'Pass an explicitly approved --max-cost-usd ceiling, at most $1.',
)
const bounds = JSON.parse(readFileSync(join(directory, 'inputs.json'), 'utf8'))
const native = new JsonProcess(join(resources, 'native/JarvisNative'), [profile])
const broker = new JsonProcess(join(resources, 'native/JarvisKeychain'), [])
const cases: Record<string, any>[] = []
const interruptions: Record<string, number>[] = []
let active: Record<string, any> | undefined
let outputCase: Record<string, any> | undefined
const starts = new WeakMap<object, number>()
let generation = 1
let speechStartedAt = 0
let playing = false
let ended = false
let finished = false
let closed = false
let error: string | undefined
let totalCostUsd = 0
const tools: string[] = []
native.on('message', (event) => {
  if (event.method === 'speech.finished' && event.params.generation === generation) {
    playing = false
    finished = true
    voice.playbackFinished()
    if (outputCase) outputCase.playedMs = event.params.playedMs
  }
})
const voice = new RealtimeVoice({
  phase: (phase) => {
    if (active && phase === 'thinking')
      active.endpointMs ??= Math.round(performance.now() - speechStartedAt - active.voiceEndMs)
  },
  transcript: (_id, role, text, final) => {
    const target = role === 'assistant' ? outputCase : active
    if (target && final) target[role] = text
  },
  begin: async () => {
    outputCase = active
    ended = false
    finished = false
    await native.request('speech.begin', { generation: ++generation })
  },
  audio: async (pcm) => {
    const queued = await native.request('speech.chunk', { pcm, generation })
    assert.equal(queued.queued, true)
    playing = true
    if (outputCase) {
      outputCase.firstAudioMs ??= Math.round(
        performance.now() - starts.get(outputCase)! - outputCase.voiceEndMs,
      )
      outputCase.audioBytes = (outputCase.audioBytes ?? 0) + Buffer.byteLength(pcm, 'base64')
    }
  },
  end: async () => {
    ended = true
    await native.request('speech.end', { generation })
  },
  interrupt: async () => {
    const wasPlaying = playing
    const at = performance.now()
    const stopped = await native.request('speech.stop', { generation: ++generation })
    if (wasPlaying)
      interruptions.push({
        stopAcknowledgmentMs: Math.round(performance.now() - at),
        inputToStopMs: Math.round(performance.now() - speechStartedAt),
        playedMs: stopped.playedMs,
      })
    playing = false
    return stopped.playedMs
  },
  tool: async (name, args) => {
    assert.equal(name, 'task_status', 'The live fixture may only read its synthetic task status')
    assert.deepEqual(args, {})
    tools.push(name)
    return { tasks: [], receipts: [], scope: 'qualification fixture' }
  },
  usage: (cost) => {
    totalCostUsd += cost
  },
  closed: (message) => {
    closed = true
    error = message
  },
})
async function stream(index: number) {
  active = { ...bounds[index], index }
  cases.push(active!)
  ended = false
  finished = false
  speechStartedAt = performance.now()
  starts.set(active!, speechStartedAt)
  const input = readFileSync(join(directory, `${index}.pcm`))
  for (let offset = 0; offset < input.length; offset += 960) {
    assert.equal(closed, false, error ?? 'The voice session closed early')
    const frame = input.subarray(offset, offset + 960)
    voice.append(frame.toString('base64'))
    await pause(Math.max(0, speechStartedAt + (offset + frame.length) / 48 - performance.now()))
  }
}
async function until(predicate: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.equal(closed, false, error ?? 'The voice session closed early')
    assert.ok(Date.now() < deadline, 'The expected realtime event did not arrive')
    voice.append(Buffer.alloc(960).toString('base64'))
    await pause(20)
  }
}
const result: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  model: REALTIME_MODEL,
  maxCostUsd,
  scope:
    'Real OpenAI WebSocket adapter, semantic VAD, signed native PCM output, and fixed read-only tool response. Native capture opens for the shared output engine; microphone frames are discarded. Only synthesized input is sent; no actual task execution.',
  humanSpeechTested: false,
  cases,
  interruptions,
  tools,
}
try {
  const route = await native.request('listen.start', { generation: 1, sampleRate: 24000 })
  assert.equal(route.voiceProcessing, true)
  assert.equal(route.playbackCancelled, true)
  const credential = await broker.request('keychain.get', { account: 'openai-realtime' })
  assert.ok(credential.value, 'Connect OpenAI in the installed application first')
  const at = performance.now()
  await voice.start(credential.value, {
    instructions:
      'You are Jarvis. Answer in one short sentence unless the user explicitly asks you to count. Use task_status when asked to check tasks. Never invent a task result.',
    maxCostUsd,
    maxSessionMs: 120_000,
    maxTokens: 512,
    history: [
      { role: 'user', content: 'Please keep answers brief.' },
      { role: 'assistant', content: 'Understood.' },
    ],
  })
  credential.value = null
  result.connectMs = Math.round(performance.now() - at)
  await stream(0)
  await until(() => ended && finished)
  assert.match(cases[0].assistant, /four|4/i)
  await stream(1)
  await until(() => playing)
  await stream(2)
  await until(() => ended && finished)
  assert.ok(interruptions.length > 0, 'New speech did not stop native playback')
  assert.match(cases[2].assistant, /Paris/i)
  await stream(3)
  await until(() => ended && finished)
  assert.deepEqual(tools, ['task_status'])
  result.passed = true
} catch (cause) {
  result.passed = false
  // Never attach the socket, request headers, credential result or raw provider events.
  result.error = cause instanceof Error ? cause.message : 'Realtime qualification failed'
  process.exitCode = 1
} finally {
  voice.stop()
  await native.request('speech.stop', { generation: ++generation }).catch(() => {})
  await native.request('audio.discard').catch(() => {})
  native.stop()
  broker.stop()
  result.reportedCostUsd = totalCostUsd
  writeFileSync('verification/realtime-live.json', JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
