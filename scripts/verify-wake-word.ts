import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Models } from '../src/core/models'
import { WAKE_MODEL } from '../src/shared/turn'
import type { QualificationResult } from '../src/shared/contracts'

// Installs the wake model if it is absent, then runs its check exactly as Settings would.
// Touches models/, model-catalog.json and ephemeral/ only; the encrypted ledger is never opened.
const profile = resolve(process.argv[2] ?? join(homedir(), 'Library/Application Support/Jarvis'))
const models = new Models(
  profile,
  resolve('workers'),
  () => {},
  (message) => {
    if (message.method === 'model.progress') process.stderr.write(`  ${message.params.stage}\n`)
  },
)
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  profile,
  microphoneRouteTested: false,
  scope:
    'The wake model is asked about three rendered fixtures over three takes: the name, a sentence that is not the name, and silence. The lowest take decides, as it does for endpointing.',
}
try {
  if (!(await models.start()))
    throw new Error('The bundled runtime is missing. Run pnpm models:setup, then try again.')
  const entry = models.records.find((model) => model.id === WAKE_MODEL)
  if (!entry) throw new Error(`${WAKE_MODEL} is not in the catalogue.`)
  if (entry.status !== 'installed') {
    process.stderr.write(`Installing ${entry.name}…\n`)
    await models.install(WAKE_MODEL)
  }
  const installed = models.records.find((model) => model.id === WAKE_MODEL)
  if (installed?.status !== 'installed') throw new Error(installed?.error ?? 'Install failed.')
  const started = performance.now()
  const result: QualificationResult = await models.qualify(WAKE_MODEL)
  results.model = {
    ...result,
    name: installed.name,
    repository: installed.repository,
    revision: installed.revision,
  }
  results.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(3))
  process.stderr.write(`\n${result.detail}\n`)
  for (const check of result.checks)
    process.stderr.write(`  ${check.passed ? 'pass' : 'FAIL'}  ${check.label}: ${check.value}\n`)
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error)
  process.stderr.write(`\nFailed: ${results.error}\n`)
} finally {
  models.stop()
}
mkdirSync('verification', { recursive: true })
writeFileSync('verification/wake-word.json', JSON.stringify(results, null, 2) + '\n')
process.stderr.write('\nWrote verification/wake-word.json\n')
process.exit(results.error ? 1 : 0)
