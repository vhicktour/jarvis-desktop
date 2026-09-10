import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonProcess } from '../src/core/process'

// Reads the Accessibility tree of applications already running and resolves one control without
// pressing it. Nothing here dispatches a press: every ui.press call passes dryRun.
const root = mkdtempSync(join(tmpdir(), 'jarvis-ui-qa-'))
const native = new JsonProcess(resolve(process.argv[2] ?? 'native/build/JarvisNative'), [root])
const call = <T = any>(method: string, params: unknown = {}) =>
  native.request<T>(method, params, 30_000)
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => 'ACCEPTED',
    (error: Error) => error.message,
  )
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  scope:
    'Accessibility enumeration and the stale-target defence in front of a press. No press was dispatched; every resolve used dryRun.',
  pressDispatched: false,
}
try {
  const info = await call('ping')
  assert.equal(info.permissions.accessibility, true, 'Accessibility is not granted to the helper.')
  const applications = await call<{ bundleId: string; app: string }[]>('ui.applications')
  assert.ok(applications.length > 0, 'No running application was reported.')
  assert.ok(
    !applications.some((item) => item.bundleId === 'personal.jarvis.desktop'),
    'Jarvis listed itself as a target.',
  )
  results.applications = applications.length
  let listing: { app: string; bundleId: string; elements: any[] } | undefined
  for (const application of applications) {
    const found = await call<typeof listing>('ui.elements', {
      bundleId: application.bundleId,
      limit: 200,
    }).catch(() => undefined)
    if (found?.elements.some((element) => element.enabled)) {
      listing = found
      break
    }
  }
  assert.ok(listing, 'No running application exposed a pressable control.')
  const control = listing.elements.find((element) => element.enabled)
  results.enumerated = { app: listing.app, controls: listing.elements.length }
  const descriptor = {
    bundleId: listing.bundleId,
    path: control.path,
    role: control.role,
    label: control.label,
  }
  const resolved = await call('ui.press', { ...descriptor, dryRun: true })
  assert.equal(resolved.resolved, true)
  assert.equal(resolved.pressed, false, 'A dry run pressed the control.')
  results.dryRunResolved = { role: control.role, depth: control.path.length }
  // Every way the target can have moved out from under the approval.
  const refusals = {
    changedLabel: await refusal(
      call('ui.press', { ...descriptor, label: `${control.label} (moved)`, dryRun: true }),
    ),
    changedRole: await refusal(
      call('ui.press', { ...descriptor, role: 'AXNotThatRole', dryRun: true }),
    ),
    movedControl: await refusal(
      call('ui.press', { ...descriptor, path: [...control.path, 99], dryRun: true }),
    ),
    jarvisItself: await refusal(
      call('ui.press', { ...descriptor, bundleId: 'personal.jarvis.desktop', dryRun: true }),
    ),
    unknownApplication: await refusal(
      call('ui.press', { ...descriptor, bundleId: 'com.example.nothing', dryRun: true }),
    ),
    enumeratingJarvis: await refusal(call('ui.elements', { bundleId: 'personal.jarvis.desktop' })),
  }
  results.refusals = refusals
  assert.match(refusals.changedLabel, /different control/i)
  assert.match(refusals.changedRole, /different control/i)
  assert.match(refusals.movedControl, /no longer where it was/i)
  assert.match(refusals.jarvisItself, /own controls/i)
  assert.match(refusals.unknownApplication, /no longer running/i)
  assert.match(refusals.enumeratingJarvis, /other than Jarvis/i)
  results.passed = true
} catch (error) {
  results.passed = false
  results.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  mkdirSync('verification', { recursive: true })
  writeFileSync('verification/ui-automation.json', JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
  await native.stopAndWait()
  rmSync(root, { recursive: true, force: true })
}
