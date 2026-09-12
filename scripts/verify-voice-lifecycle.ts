import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { JsonProcess } from '../src/core/process'

// Real native protocol and audio engine; silent fixtures, not human interruption accuracy.
const profile = mkdtempSync(join(tmpdir(), 'jarvis-voice-'))
const ephemeral = join(profile, 'ephemeral')
mkdirSync(ephemeral)
const native = new JsonProcess(resolve('native/build/JarvisNative'), [profile])
const events: { method: string; params: any }[] = []
native.on('message', (event) => events.push(event))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const completed = (generation: number) =>
  events.filter((event) => event.method === 'speech.finished' && event.params.generation === generation)
const samples = Buffer.alloc(24000 / 5 * 2)
const header = Buffer.alloc(44)
header.write('RIFF'); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples.length, 40)
const path = join(ephemeral, 'silence.wav')
writeFileSync(path, Buffer.concat([header, samples]))
const result: Record<string, unknown> = { generatedAt: new Date().toISOString(), humanSpeechTested: false }
try {
  await native.request('speech.begin', { generation: 100 })
  assert.equal((await native.request('speech.enqueue', { path, generation: 100 })).queued, true)
  await pause(400)
  assert.equal(completed(100).length, 0, 'A gap between chunks must not finish the reply')
  const microphone = await native.request('listen.start', { generation: 7 })
  assert.equal(microphone.generation, 7)
  assert.equal((await native.request('speech.enqueue', { path, generation: 100 })).queued, true,
    'Opening the microphone must not invalidate playback')
  await pause(450)
  assert.equal(completed(100).length, 0)
  await native.request('speech.end', { generation: 100 })
  await pause(50)
  assert.equal(completed(100).length, 1)
  await native.request('speech.end', { generation: 100 })
  await pause(20)
  assert.equal(completed(100).length, 1, 'Finishing twice must not reopen the microphone twice')
  await native.request('speech.stop', { generation: 101 })
  assert.equal((await native.request('speech.enqueue', { path, generation: 100 })).queued, false)
  await native.request('listen.stop', { generation: 6 })
  assert.equal((await native.request('ping')).listening, true, 'Stale cleanup must not close a newer microphone')
  const stream = await native.request('listen.start', { generation: 8, sampleRate: 24000, preRollSeconds: 0.2 })
  assert.equal(stream.sampleRate, 24000)
  assert.equal(stream.playbackCancelled, true)
  assert.ok(Buffer.from(stream.preRollPCM, 'base64').length >= 9000, 'Switching capture rate must carry wake audio at 24 kHz')
  await native.request('speech.begin', { generation: 200 })
  assert.equal((await native.request('speech.chunk', { pcm: samples.toString('base64'), generation: 200 })).queued, true)
  await pause(400)
  assert.equal(completed(200).length, 0)
  await native.request('speech.end', { generation: 200 })
  await pause(30)
  assert.equal(completed(200).length, 1)
  assert.equal(completed(200)[0].params.playedMs, 200)
  assert.ok(events.some((event) => event.method === 'audio.level' && event.params.generation === 8 && event.params.sampleRate === 24000))
  const capture = events.filter((event) => event.method === 'audio.level' && event.params.pcm).map((event) => event.params)
  assert.ok(capture.length > 0, 'The native microphone did not stream PCM')
  for (const frame of capture) {
    const pcm = Buffer.from(frame.pcm, 'base64')
    let energy = 0
    for (let index = 0; index < pcm.length; index += 2) energy += (pcm.readInt16LE(index) / 32768) ** 2
    const level = Math.min(1, Math.sqrt(energy / (pcm.length / 2)) * 7)
    assert.ok(Math.abs(frame.pcmLevel - level) < 1e-6, 'PCM metering did not describe the transmitted bytes')
  }
  const peakInputLevel = Math.max(...capture.map((frame) => frame.level))
  const peakPCMLevel = Math.max(...capture.map((frame) => frame.pcmLevel))
  assert.ok(peakInputLevel > 0.001, 'No microphone signal was available to validate conversion')
  assert.ok(peakPCMLevel > 0.001, 'The input meter is live but the detector PCM is silent')
  await native.request('audio.start', { generation: 9, preRollSeconds: 0.2 })
  await pause(200)
  const recording = await native.request('audio.stop')
  const recorded = readFileSync(recording.path)
  const format = recorded.indexOf(Buffer.from('fmt '))
  assert.ok(format >= 0, 'The microphone recording has no WAV format header')
  assert.equal(recorded.readUInt16LE(format + 10), 1, 'Recognition must receive only the microphone channel')
  result.capture = {
    inputChannels: [...new Set(capture.map((frame) => frame.inputChannels))],
    inputSampleRates: [...new Set(capture.map((frame) => frame.inputSampleRate))],
    outputSampleRates: [...new Set(capture.map((frame) => frame.sampleRate))],
    peakInputLevel,
    peakPCMLevel,
    recordingChannels: 1,
  }
  result.passed = true
  result.checks = ['stream starvation', 'capture/playback isolation', 'single completion', 'stale audio rejection', 'stale microphone cleanup', '24 kHz capture and playback', 'played duration', 'non-silent microphone conversion', 'mono recognition recording']
} catch (error) {
  result.passed = false
  result.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await native.request('audio.discard').catch(() => {})
  native.stop()
  rmSync(profile, { recursive: true, force: true })
  writeFileSync('verification/voice-lifecycle.json', JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
