import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { JsonProcess } from '../src/core/process'
const root = realpathSync(mkdtempSync('/tmp/jarvis-audio-test-'))
mkdirSync(join(root, 'ephemeral'))
function wave(name: string, seconds: number, amplitude: number) {
  const rate = 24000,
    length = Math.floor(seconds * rate)
  const data = Buffer.alloc(44 + length * 2)
  data.write('RIFF')
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(rate, 24)
  data.writeUInt32LE(rate * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(length * 2, 40)
  for (let i = 0; i < length; i++)
    data.writeInt16LE(
      Math.round(
        Math.sin((i / rate) * 440 * Math.PI * 2) *
          amplitude *
          32767 *
          (0.5 + 0.5 * Math.sin((i / rate) * 17)),
      ),
      44 + i * 2,
    )
  const path = join(root, 'ephemeral', name + '.wav')
  writeFileSync(path, data)
  return path
}
const quietTone = wave('meter', 0.6, 0.001)
const silence = wave('silence', 1, 0)
const native = new JsonProcess(resolve(process.argv[2] ?? 'native/build/JarvisNative'), [root])
const levels: number[] = []
native.on('message', (message) => {
  if (message.method === 'speech.level') levels.push(message.params.level)
})
try {
  const status = await native.request('speech.status')
  await native.request('speech.play', { path: quietTone, generation: 1 })
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.ok(levels.length >= 5, 'Playback metering did not emit enough samples')
  assert.ok(
    Math.max(...levels) > Math.min(...levels),
    'Playback metering did not follow the waveform',
  )
  const timings: number[] = []
  for (let i = 0; i < 100; i++) {
    await native.request('speech.play', { path: silence, generation: i * 2 + 2 })
    const before = await native.request('speech.status')
    assert.equal(before.playing, true)
    const start = performance.now()
    await native.request('speech.stop', { generation: i * 2 + 3 })
    timings.push(performance.now() - start)
    const after = await native.request('speech.status')
    assert.equal(after.playing, false)
    assert.equal(after.speaking, false)
  }
  timings.sort((a, b) => a - b)
  const result = {
    generatedAt: new Date().toISOString(),
    trials: 100,
    outputRoute: status.outputRoute,
    boundary: 'NDJSON request through AVAudioPlayer.stop acknowledgement',
    hardwareAcousticLatencyMeasured: false,
    stopP95Ms: timings[94],
    stopMaxMs: timings[99],
    meteringSamples: levels.length,
    meteringVaries: true,
  }
  mkdirSync('verification', { recursive: true })
  writeFileSync('verification/native-audio.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await native.stopAndWait()
  rmSync(root, { recursive: true, force: true })
}
