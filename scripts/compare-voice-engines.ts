import { writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Models } from '../src/core/models'

// Compare the shipped worker and the same synthesized input in both existing voice routes.
// No microphone, cloud, ledger or external effect. This is component latency, not acoustic latency.
const profile = join(homedir(), 'Library/Application Support/Jarvis')
const workers = join(homedir(), 'Applications/Jarvis.app/Contents/Resources/workers')
const prompts = [
  'What is two plus two?',
  'What is the capital of France?',
  'Give me one useful tip for naming a function.',
]
const instructions =
  'You are Jarvis, a helpful personal assistant. Answer in one short sentence. No preamble, no restating the question and no offer of more help. Your answer is spoken: no markdown or lists.'
const result: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  workers,
  scope:
    'Three synthesized utterances, Whisper ASR followed by the selected local route. Exact history prefix prepared for the pipeline. First audio is a worker event, not native or acoustic output.',
  humanSpeechTested: false,
  engines: {},
}
const inputs: string[] = []
const audio: string[] = []
let models: Models | undefined
let firstAudioMs: number | undefined
let began = 0
let active = ''
const factory = () =>
  new Models(
    profile,
    workers,
    () => {},
    (message) => {
      if (['chat.audio', 'duplex.audio'].includes(message.method)) {
        audio.push(message.params.path)
        if (message.params.conversationId === active && firstAudioMs === undefined)
          firstAudioMs = performance.now() - began
      }
    },
  )
try {
  models = factory()
  await models.start()
  for (const text of prompts)
    inputs.push((await models.request('tts', { text, voice: 'bm_george', speed: 1 })).path)
  models.stop()
  for (const engine of ['pipeline', 'duplex']) {
    models = factory()
    await models.start()
    const warm = performance.now()
    await models.warm(engine === 'pipeline' ? ['asr', 'reasoning', 'tts'] : ['duplex', 'asr'])
    const warmedMs = performance.now() - warm
    const history: { role: 'user' | 'assistant'; content: string }[] = []
    const cases: unknown[] = []
    for (let index = 0; index < prompts.length; index++) {
      const prepared = performance.now()
      if (engine === 'pipeline')
        await models.request('chat.prepare', {
          messages: [{ role: 'system', content: instructions }, ...history],
        })
      const preparationMs = performance.now() - prepared
      active = `${engine}-${index}`
      firstAudioMs = undefined
      began = performance.now()
      const transcript = (await models.request('asr', { path: inputs[index], model: 'whisper' }))
        .text
      const asrMs = performance.now() - began
      const reply = await models.request(
        engine === 'pipeline' ? 'chat' : 'duplex',
        engine === 'pipeline'
          ? {
              conversationId: active,
              messages: [
                { role: 'system', content: instructions },
                ...history,
                { role: 'user', content: transcript },
              ],
              maxTokens: 60,
              maxSentences: 1,
              speak: { voice: 'bm_george', speed: 1 },
            }
          : {
              conversationId: active,
              path: inputs[index],
              instructions,
              history: history.map(({ role, content }) => ({ role, text: content })),
              maxSeconds: 8,
            },
      )
      if (firstAudioMs === undefined) throw new Error(`${engine} produced no audio`)
      const value = {
        input: prompts[index],
        transcript,
        reply: reply.text,
        asrMs: Math.round(asrMs),
        firstAudioMs: Math.round(firstAudioMs),
        totalMs: Math.round(performance.now() - began),
        preparationMs: Math.round(preparationMs),
      }
      cases.push(value)
      history.push(
        { role: 'user', content: transcript },
        { role: 'assistant', content: reply.text },
      )
      console.log(JSON.stringify({ engine, ...value }))
    }
    ;(result.engines as Record<string, unknown>)[engine] = {
      warmedMs: Math.round(warmedMs),
      cases,
      memory: await models.request('ping'),
    }
    models.stop()
  }
  result.completed = true
} catch (error) {
  result.completed = false
  result.error = String(error)
  process.exitCode = 1
} finally {
  models?.stop()
  for (const path of [...inputs, ...audio]) rmSync(path, { force: true })
  writeFileSync('verification/voice-engine-comparison.json', JSON.stringify(result, null, 2) + '\n')
}
