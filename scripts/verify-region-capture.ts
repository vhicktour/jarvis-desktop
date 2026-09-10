import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonProcess } from '../src/core/process'

// Captures parts of this screen into a temporary folder and deletes them again. No image
// content is recorded here; only sizes, and whether two different areas produced different files.
const root = mkdtempSync(join(tmpdir(), 'jarvis-region-qa-'))
mkdirSync(join(root, 'ephemeral'), { recursive: true })
const native = new JsonProcess(resolve(process.argv[2] ?? 'native/build/JarvisNative'), [root])
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  scope:
    'Region capture through the native helper: crop position, size, protected-app refusal, and bounds refusal.',
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => 'ACCEPTED',
    (error: Error) => error.message,
  )
try {
  const info = await native.request('ping')
  assert.equal(info.permissions.screen, 'granted', 'Screen Recording is not granted to the helper.')
  const displays = await native.request('context.displays')
  assert.ok(displays.length > 0, 'No display was reported.')
  const display = displays[0]
  results.displays = displays.length
  const area = (x: number, y: number, width: number, height: number, excludedApps: string[] = []) =>
    native.request('context.region', { x, y, width, height, excludedApps }, 60_000)
  const full = await area(display.x, display.y, display.width, display.height)
  const left = await area(display.x, display.y, display.width / 2, display.height)
  const right = await area(
    display.x + display.width / 2,
    display.y,
    display.width / 2,
    display.height,
  )
  const captures = { full, left, right }
  // A capture is scaled down to 1280 points wide at most, keeping its aspect ratio.
  const expected = (width: number, height: number) => {
    const scale = Math.min(1, 1280 / width)
    return { width: Math.trunc(width * scale), height: Math.trunc(height * scale) }
  }
  assert.deepEqual(
    { width: full.width, height: full.height },
    expected(display.width, display.height),
  )
  assert.deepEqual(
    { width: left.width, height: left.height },
    expected(display.width / 2, display.height),
  )
  assert.notEqual(
    digest(left.imagePath),
    digest(right.imagePath),
    'Both halves captured the same pixels; the crop is not being positioned.',
  )
  assert.notEqual(digest(full.imagePath), digest(left.imagePath))
  for (const capture of Object.values(captures)) {
    assert.equal(capture.windowId, 0)
    assert.equal(capture.app, 'Selected area')
  }
  results.captures = Object.fromEntries(
    Object.entries(captures).map(([name, capture]) => [
      name,
      { width: capture.width, height: capture.height, bytes: statSync(capture.imagePath).size },
    ]),
  )
  results.halvesDiffer = true
  const onScreen = await native.request('context.windows')
  const protectedApp = onScreen.find((window: { bundleId: string }) => window.bundleId)?.bundleId
  results.protectedAppRefusal = protectedApp
    ? await refusal(area(display.x, display.y, display.width, display.height, [protectedApp]))
    : 'No on-screen application was available to exclude.'
  results.tooSmallRefusal = await refusal(area(display.x, display.y, 4, 4))
  results.offDisplayRefusal = await refusal(area(99_999, 99_999, 200, 200))
  if (protectedApp) assert.match(String(results.protectedAppRefusal), /protected application/i)
  assert.match(String(results.tooSmallRefusal), /larger area/i)
  assert.match(String(results.offDisplayRefusal), /connected display/i)
  for (const capture of Object.values(captures))
    await native.request('ephemeral.delete', { path: capture.imagePath })
  results.passed = true
} catch (error) {
  results.passed = false
  results.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  mkdirSync('verification', { recursive: true })
  writeFileSync('verification/region-capture.json', JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
  await native.stopAndWait()
  rmSync(root, { recursive: true, force: true })
}
