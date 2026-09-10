import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Models } from '../src/core/models'
const root = resolve(process.argv[2] ?? '/tmp/jarvis-native-qa2')
const models = new Models(
  root,
  resolve('workers'),
  () => {},
  () => {},
)
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  microphoneRouteTested: false,
}
const temporary: string[] = []
try {
  await models.start()
  const text = 'Good evening. I am Jarvis. Ready when you are.'
  const speech = await models.request('tts', { text, voice: 'bm_george' })
  temporary.push(speech.path)
  results.tts = { duration: speech.duration, sampleRate: speech.sampleRate }
  for (const model of ['parakeet', 'whisper']) {
    const start = performance.now()
    const result = await models.request('asr', { path: speech.path, model })
    results[model] = { ...result, elapsedSeconds: (performance.now() - start) / 1000 }
    assert.match(result.text.toLowerCase(), /ready when you are/)
  }
  const response = await models.request('chat', {
    messages: [
      { role: 'system', content: 'Answer with just the number.' },
      { role: 'user', content: 'What is 2 + 2?' },
    ],
    maxTokens: 30,
  })
  results.reasoning = response
  assert.equal(response.text.trim(), '4')
  const embeddings = await models.request('embed', {
    texts: ['A quiet companion', 'A quiet assistant'],
  })
  results.embedding = { dimensions: embeddings.vectors[0].length, count: embeddings.vectors.length }
  assert.equal(embeddings.vectors.length, 2)
  assert.equal(embeddings.vectors[0].length, 1024)
  const runtime = JSON.parse(readFileSync('workers/runtime.json', 'utf8'))
  const padded = speech.path.replace('.wav', '-endpoint.wav')
  const silence = speech.path.replace('.wav', '-silence.wav')
  temporary.push(padded, silence)
  await promisify(execFile)(resolve('workers', runtime.python), [
    '-c',
    'import soundfile as sf,numpy as np,sys; a,r=sf.read(sys.argv[1]); sf.write(sys.argv[2],np.concatenate([a,np.zeros(int(r*1.5))]),r); sf.write(sys.argv[3],np.zeros(r*3),r)',
    speech.path,
    padded,
    silence,
  ])
  results.endpointSpeech = await models.request('endpoint', { path: padded })
  results.endpointSilence = await models.request('endpoint', { path: silence })
  assert.equal((results.endpointSpeech as any).hasSpeech, true)
  assert.equal((results.endpointSilence as any).complete, false)
  results.endpointQualification = {
    passed: (results.endpointSpeech as any).complete,
    detail:
      'Single synthesized fixture only. Automatic endpointing stays experimental and off by default.',
  }
  results.memory = await models.request('ping', {})
  results.modelRevisions = models.records
    .filter((m) => m.status === 'installed')
    .map((m) => ({ id: m.id, revision: m.revision }))
  results.passed = true
  results.scope =
    'Required local speech, reasoning, embedding, and endpoint interface smoke checks. Semantic endpoint accuracy is reported separately.'
} catch (error) {
  results.passed = false
  results.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  for (const path of temporary) rmSync(path, { force: true })
  mkdirSync('verification', { recursive: true })
  writeFileSync('verification/local-model-smoke-corrected.json', JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results))
  models.stop()
}
