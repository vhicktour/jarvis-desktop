import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Models } from '../src/core/models'
import { ENDPOINT_PAUSE_SECONDS } from '../src/shared/turn'

/**
 * Streams rendered speech through the model worker's listener the way the native tap does — 16 kHz
 * frames at real-time pace — and records when the voice model heard speech start and stop, and what
 * the turn model said a quarter of a second into the pause. Touches models/ and ephemeral/ only.
 */
const profile = resolve(process.argv[2] ?? join(homedir(), 'Library/Application Support/Jarvis'))
const runtime = JSON.parse(readFileSync('workers/runtime.json', 'utf8'))
const python = resolve('workers', runtime.python)
const FRAME = 512
type Heard = { speaking: boolean; at: number; wall: number }
let ready: number | undefined
let heard: Heard[] = []
let errors: string[] = []
const temporary: string[] = []
const started = performance.now()
const models = new Models(
  profile,
  resolve('workers'),
  () => {},
  (message) => {
    if (message.method === 'listen.ready') ready = performance.now() - started
    if (message.method === 'listen.speech')
      heard.push({ ...message.params, wall: performance.now() - started })
    if (message.method === 'listen.error') errors.push(String(message.params?.message))
  },
)
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  profile,
  microphoneRouteTested: false,
  scope:
    'Rendered speech is streamed to the listener as 16 kHz frames at real-time pace. Recorded: when speech was heard to start and stop against where it actually is in the clip, and the turn model’s verdict a quarter of a second into the pause, for a finished question, an unfinished one, and silence.',
}
function pcm16k(path: string, lead: number, tail: number) {
  const raw = join(tmpdir(), `jarvis-turn-${process.pid}.raw`)
  const bounds = execFileSync(python, [
    '-c',
    [
      'import sys, numpy as np, soundfile as sf',
      'from scipy.signal import resample_poly',
      'from math import gcd',
      'audio, rate = sf.read(sys.argv[1], dtype="float32", always_2d=True)',
      'audio = audio.mean(axis=1)',
      'g = gcd(rate, 16000)',
      'audio = resample_poly(audio, 16000 // g, rate // g).astype(np.float32) if rate != 16000 else audio',
      'lead, tail = float(sys.argv[3]), float(sys.argv[4])',
      'out = np.concatenate([np.zeros(int(16000 * lead), np.float32), audio, np.zeros(int(16000 * tail), np.float32)])',
      '(out * 32767).astype(np.int16).tofile(sys.argv[2])',
      '# Where the voice actually is: a render carries its own quiet at both ends.',
      'loud = np.flatnonzero(np.abs(audio) > 0.02)',
      'print(lead + loud[0] / 16000, lead + loud[-1] / 16000)',
    ].join('\n'),
    path,
    raw,
    String(lead),
    String(tail),
  ])
    .toString()
    .trim()
    .split(' ')
    .map(Number)
  return { raw, from: bounds[0], to: bounds[1] }
}
async function stream(generation: number, raw: string, askAt?: number) {
  const bytes = readFileSync(raw)
  const samples = bytes.length / 2
  let sent = 0
  let asked: Record<string, unknown> | undefined
  heard = []
  const began = performance.now()
  while (sent < samples) {
    const count = Math.min(FRAME, samples - sent)
    const chunk = bytes.subarray(sent * 2, (sent + count) * 2)
    sent += count
    const elapsed = sent / 16000
    models.notify('audio.frame', { generation, elapsed, pcm: chunk.toString('base64') })
    // Real-time pace: frames arrive no faster than the microphone would deliver them.
    const due = began + elapsed * 1000
    const wait = due - performance.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    if (askAt !== undefined && !asked && elapsed >= askAt) {
      const at = performance.now()
      try {
        const verdict = await models.request('endpoint', { generation }, undefined, 5000)
        asked = { askedAt: elapsed, latencyMs: Math.round(performance.now() - at), ...verdict }
      } catch (error) {
        asked = { askedAt: elapsed, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
  // Let the last frames be judged before reading what was heard.
  await new Promise((r) => setTimeout(r, 150))
  return { heard: heard.map(({ speaking, at }) => ({ speaking, at })), asked }
}
try {
  if (!(await models.start()))
    throw new Error('The bundled runtime is missing. Run pnpm models:setup, then try again.')
  for (const id of ['silero', 'smart-turn', 'kokoro'])
    if (!models.has(id)) throw new Error(`Install ${id} in Settings → Local models first.`)
  const cases: Record<string, unknown> = {}
  const render = async (text: string) =>
    models.request('tts', { text, voice: 'bm_george', speed: 1 })
  const question = await render(
    "What's the weather going to be like in London tomorrow, and should I take an umbrella?",
  )
  const unfinished = await render('So what I was thinking is that maybe we could look at the')
  let generation = 100
  for (const [label, clip, lead, tail] of [
    ['finished question', question, 0.5, 2.0],
    ['unfinished thought', unfinished, 0.5, 2.0],
  ] as const) {
    generation++
    const { raw, from, to } = pcm16k(clip.path, lead, tail)
    temporary.push(raw)
    models.notify('listen.configure', { generation })
    // Asked a quarter of a second into the pause, as the service worker would.
    const outcome = await stream(generation, raw, to + ENDPOINT_PAUSE_SECONDS + 0.1)
    const start = outcome.heard.find((h) => h.speaking)
    const stop = [...outcome.heard].reverse().find((h) => !h.speaking)
    cases[label] = {
      clipSeconds: Number(clip.duration.toFixed(2)),
      speechFrom: Number(from.toFixed(3)),
      speechTo: Number(to.toFixed(3)),
      heardStartAt: start?.at,
      heardStopAt: stop?.at,
      startErrorMs: start ? Math.round((start.at - from) * 1000) : null,
      stopErrorMs: stop ? Math.round((stop.at - to) * 1000) : null,
      transitions: outcome.heard.length,
      turnModel: outcome.asked,
    }
    process.stderr.write(`${label}: ${JSON.stringify(cases[label])}\n`)
  }
  generation++
  const silence = join(tmpdir(), `jarvis-turn-silence-${process.pid}.raw`)
  writeFileSync(silence, Buffer.alloc(16000 * 3 * 2))
  temporary.push(silence)
  models.notify('listen.configure', { generation })
  const quiet = await stream(generation, silence, 2.5)
  cases['silence'] = { transitions: quiet.heard.length, turnModel: quiet.asked }
  process.stderr.write(`silence: ${JSON.stringify(cases['silence'])}\n`)
  results.readyAfterMs = ready ? Math.round(ready) : null
  results.cases = cases
  results.errors = errors
  const finished = cases['finished question'] as any
  const open = cases['unfinished thought'] as any
  results.passed =
    errors.length === 0 &&
    finished.turnModel?.complete === true &&
    open.turnModel?.complete === false &&
    (cases['silence'] as any).transitions === 0 &&
    // Three frames of debounce at the start; a hysteresis frame or two at the end.
    Math.abs(finished.startErrorMs) < 200 &&
    Math.abs(finished.stopErrorMs) < 250
  temporary.push(question.path, unfinished.path)
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error)
  results.passed = false
  process.stderr.write(`\nFailed: ${results.error}\n`)
} finally {
  models.stop()
  for (const path of temporary) rmSync(path, { force: true })
}
mkdirSync('verification', { recursive: true })
writeFileSync('verification/turn-detection.json', JSON.stringify(results, null, 2) + '\n')
process.stderr.write(`\nWrote verification/turn-detection.json (passed: ${results.passed})\n`)
process.exit(results.passed ? 0 : 1)
