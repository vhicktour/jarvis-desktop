import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Models } from '../src/core/models'
import type { QualificationResult } from '../src/shared/contracts'

// Checks touch models/, model-catalog.json, and ephemeral/ only. The encrypted ledger is never opened.
const profile = resolve(process.argv[2] ?? join(homedir(), 'Library/Application Support/Jarvis'))
const models = new Models(
  profile,
  resolve('workers'),
  () => {},
  (message) => {
    if (message.method === 'model.progress')
      process.stderr.write(`  ${message.params.id}: ${message.params.stage}\n`)
  },
)
type Entry = QualificationResult & { name: string; installed: boolean }
const entries: Entry[] = []
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  profile,
  microphoneRouteTested: false,
  scope:
    'Each installed model runs the observable behavior its role is relied on for, against the installed revision on this Mac. Results are recorded in each model manifest.',
}
try {
  const started = performance.now()
  if (!(await models.start()))
    throw new Error('The bundled runtime is missing. Run pnpm models:setup, then try again.')
  for (const model of models.records) {
    if (model.status !== 'installed') {
      process.stderr.write(`Skipping ${model.name} (${model.status}).\n`)
      entries.push({
        id: model.id,
        name: model.name,
        role: model.role,
        revision: '',
        installed: false,
        qualified: false,
        checks: [],
        elapsedSeconds: 0,
        detail: model.experimental
          ? 'Research profile. Installation is refused until a qualified Mac adapter exists.'
          : 'Not installed on this profile.',
      })
      continue
    }
    process.stderr.write(`Checking ${model.name}…\n`)
    try {
      entries.push({ ...(await models.qualify(model.id)), name: model.name, installed: true })
    } catch (error) {
      entries.push({
        id: model.id,
        name: model.name,
        role: model.role,
        revision: model.revision ?? '',
        installed: true,
        qualified: false,
        checks: [],
        elapsedSeconds: 0,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    process.stderr.write(`  → ${entries.at(-1)!.detail}\n`)
  }
  const installed = entries.filter((entry) => entry.installed)
  results.models = entries
  results.memory = await models.request('ping', {})
  results.elapsedSeconds = (performance.now() - started) / 1000
  results.installed = installed.length
  results.qualified = installed.filter((entry) => entry.qualified).length
  results.passed = installed.length > 0 && installed.every((entry) => entry.qualified)
  if (!results.passed) process.exitCode = 1
} catch (error) {
  results.models = entries
  results.passed = false
  results.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  mkdirSync('verification', { recursive: true })
  writeFileSync('verification/model-qualification.json', JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results))
  models.stop()
}
