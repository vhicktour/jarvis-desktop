import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { JsonProcess } from '../src/core/process'
import { Models } from '../src/core/models'

/**
 * Plays Jarvis's own voice out of this Mac's speaker while its microphone is open, and asks the
 * voice model how much of it came back as speech. That is the acoustic question interruption
 * rests on: with echo cancellation working, the open microphone should hear almost none of the
 * reply; the same reply played by a route the canceller never sees is the comparison.
 *
 * Uses the real speaker and microphone, so the room has to be quiet. Touches ephemeral/ only.
 */
const profile = resolve(process.argv[2] ?? join(homedir(), 'Library/Application Support/Jarvis'))
const runtime = JSON.parse(readFileSync('workers/runtime.json', 'utf8'))
const python = resolve('workers', runtime.python)
const native = new JsonProcess(resolve('native/build/JarvisNative'), [profile])
/**
 * The control without which the rest proves nothing: the raw microphone, no cancellation, while
 * the same clip plays. A microphone that cannot hear the speaker at all would also report silence.
 */
function rawMicrophone(clip: string) {
  const out = execFileSync(python, [
    '-c',
    [
      'import subprocess, sys, time, numpy as np, sounddevice as sd',
      "sys.path.insert(0, 'workers')",
      'from endpoint import session',
      'rec = sd.rec(int(16000 * 8), samplerate=16000, channels=1, dtype="float32")',
      'time.sleep(0.4)',
      "subprocess.run(['afplay', sys.argv[1]])",
      'sd.wait()',
      'audio = rec[:, 0]',
      'vad = session(sys.argv[2])',
      'state = np.zeros((2, 1, 128), dtype=np.float32); context = np.zeros(64, dtype=np.float32); probs = []',
      'for off in range(0, len(audio) - 512, 512):',
      '    chunk = audio[off:off + 512]',
      '    out, state = vad.run(None, {"input": np.concatenate([context, chunk])[None, :], "state": state, "sr": np.array(16000, dtype=np.int64)})',
      '    context = chunk[-64:]; probs.append(float(out[0, 0]))',
      'probs = np.array(probs)',
      'print(sd.query_devices(kind="input")["name"], "|", sd.query_devices(kind="output")["name"], "|", float(np.sqrt(np.mean(audio ** 2))), "|", float((probs > 0.5).mean()))',
    ].join('\n'),
    clip,
    join(profile, 'models/silero/weights/onnx/model.onnx'),
  ])
    .toString()
    .trim()
    .split('\n')
    .at(-1)!
    .split(' | ')
  return {
    microphone: out[0],
    speaker: out[1],
    rms: Number(Number(out[2]).toFixed(4)),
    speechFraction: Number(Number(out[3]).toFixed(3)),
  }
}
let generation = 500
let speechFrames = 0
let frames = 0
let speaking = false
let transitions: { speaking: boolean; at: number }[] = []
const models = new Models(
  profile,
  resolve('workers'),
  () => {},
  (message) => {
    if (message.method === 'listen.speech') {
      transitions.push({ speaking: message.params.speaking, at: message.params.at })
      speaking = message.params.speaking
    }
  },
)
native.on('message', (message: any) => {
  if (message.method === 'audio.level' && message.params.generation === generation) {
    frames++
    if (speaking) speechFrames++
    if (message.params.pcm)
      models.notify('audio.frame', {
        generation,
        elapsed: message.params.elapsed,
        pcm: message.params.pcm,
      })
  }
})
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  profile,
  microphoneRouteTested: true,
  scope:
    'One rendered reply is played out of the speaker twice while the microphone is open: through the audio engine, where Apple’s echo cancellation subtracts it, and through a player outside the engine. The voice model reports how much of each came back as speech.',
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function measure(
  label: string,
  path: string,
  duration: number,
  play: (path: string, duration: number) => Promise<void>,
  before?: () => Promise<void>,
) {
  generation++
  speechFrames = 0
  frames = 0
  speaking = false
  transitions = []
  if (before) await before()
  const opened = await native.request('listen.start', { generation })
  models.notify('listen.configure', { generation })
  await wait(700)
  const idleTransitions = transitions.length
  await play(path, duration)
  await wait(400)
  await native.request('listen.stop', { generation })
  const spoken = transitions.reduce<{ total: number; since?: number }>(
    (acc, t) => {
      if (t.speaking) return { ...acc, since: t.at }
      if (acc.since !== undefined)
        return { total: acc.total + (t.at - acc.since), since: undefined }
      return acc
    },
    { total: 0 },
  )
  const row = {
    voiceProcessing: opened.voiceProcessing,
    replySeconds: Number(duration.toFixed(2)),
    speechHeardSeconds: Number(spoken.total.toFixed(2)),
    speechFraction: Number((spoken.total / duration).toFixed(3)),
    transitions: transitions.length - idleTransitions,
    idleTransitionsBeforePlayback: idleTransitions,
    frames,
  }
  process.stderr.write(`${label}: ${JSON.stringify(row)}\n`)
  return row
}
try {
  await native.request('ping')
  if (!(await models.start())) throw new Error('The bundled runtime is missing.')
  for (const id of ['silero', 'kokoro'])
    if (!models.has(id)) throw new Error(`Install ${id} in Settings → Local models first.`)
  const clip = await models.request('tts', {
    text: 'It should stay dry until the evening, so leave the umbrella at home. The review is at three, and your calendar is otherwise clear.',
    voice: 'bm_george',
    speed: 1,
  })
  const finished = () =>
    new Promise<void>((resolveDone) => {
      const listener = (message: any) => {
        if (message.method === 'speech.finished') {
          native.off('message', listener)
          resolveDone()
        }
      }
      native.on('message', listener)
    })
  results.rawMicrophone = rawMicrophone(clip.path)
  process.stderr.write(`raw microphone: ${JSON.stringify(results.rawMicrophone)}\n`)
  // Through the engine: the microphone is open, so playback takes the route the canceller sees.
  results.throughEngine = await measure(
    'through the engine',
    clip.path,
    clip.duration,
    async (path) => {
      const done = finished()
      await native.request('speech.play', { path, generation })
      await done
    },
  )
  // Outside the engine: playback starts before the microphone opens, so it takes the other route.
  results.outsideEngine = await measure(
    'outside the engine',
    clip.path,
    clip.duration,
    async (_path, duration) => {
      await wait(duration * 1000 + 300)
    },
    async () => {
      await native.request('speech.play', { path: clip.path, generation: generation + 1 })
    },
  ).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
  await native.request('ephemeral.delete', { path: clip.path })
  const engine = results.throughEngine as any
  const raw = results.rawMicrophone as any
  // Meaningful only where the raw microphone plainly hears the speaker.
  results.passed =
    raw.speechFraction >= 0.2 && engine.voiceProcessing === true && engine.speechFraction < 0.15
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error)
  results.passed = false
  process.stderr.write(`\nFailed: ${results.error}\n`)
} finally {
  models.stop()
  native.stop()
}
mkdirSync('verification', { recursive: true })
writeFileSync('verification/barge-in.json', JSON.stringify(results, null, 2) + '\n')
process.stderr.write(`\nWrote verification/barge-in.json (passed: ${results.passed})\n`)
process.exit(results.passed ? 0 : 1)
