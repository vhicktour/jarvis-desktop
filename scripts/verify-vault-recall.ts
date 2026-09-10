import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Models } from '../src/core/models'
import { Store } from '../src/core/store'
import { VaultIndex, VAULT_SCOPE } from '../src/core/vault'

// Reads the chosen folder; indexes it into a throwaway encrypted ledger under the system temp
// directory. Note titles and excerpts go to verification/private, which git ignores.
const vaultPath = resolve(process.argv[2] ?? '')
const profile = resolve(process.argv[3] ?? '/private/tmp/jarvis-native-qa2')
const queries = process.argv.slice(4)
if (!process.argv[2]) {
  console.error('Usage: verify-vault-recall.ts <notes folder> [model profile] [query …]')
  process.exit(2)
}
const directory = mkdtempSync(join(tmpdir(), 'jarvis-vault-qa-'))
const store = new Store(join(directory, 'ledger.db'), randomBytes(32))
const models = new Models(
  profile,
  resolve('workers'),
  () => {},
  () => {},
)
const vault = new VaultIndex(store, models, () => {})
const summary: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  scope: VAULT_SCOPE,
  scope_note:
    'Indexed into a disposable ledger. Note titles and excerpts are written to verification/private only.',
}
const detail: Record<string, unknown> = { ...summary, vaultPath }
try {
  const started = performance.now()
  await models.start()
  await vault.connect(vaultPath)
  await vault.sync()
  const indexed = vault.status()
  summary.indexSeconds = Number(((performance.now() - started) / 1000).toFixed(2))
  summary.notes = indexed.notes
  summary.chunks = indexed.chunks
  summary.embedded = indexed.embedded
  summary.bytes = indexed.bytes
  summary.redactedCredentialPassages = indexed.redacted
  summary.skippedFiles = indexed.skipped
  summary.error = indexed.error
  const asked = queries.length
    ? queries
    : ['what did we decide about the orb overlay', 'how should I host a personal site']
  const results = []
  for (const query of asked) {
    const at = performance.now()
    const vector = models.has('embedding')
      ? await models
          .request('embed', { texts: [query] })
          .then((result) => ({ values: result.vectors[0], revision: result.revision }))
      : undefined
    const hits = store.searchNotes(query, VAULT_SCOPE, vector)
    results.push({
      query,
      elapsedMs: Number((performance.now() - at).toFixed(1)),
      hits: hits.length,
      titles: hits.map((hit) => hit.title),
      excerpts: hits.map((hit) => ({
        title: hit.title,
        heading: hit.heading,
        text: hit.text.slice(0, 400),
      })),
    })
  }
  detail.recall = results
  summary.recall = results.map(({ query, elapsedMs, hits }) => ({ query, elapsedMs, hits }))
  // Forgetting must leave nothing behind that recall can still reach.
  vault.forget()
  summary.afterForget = {
    notes: vault.status().notes,
    hits: store.searchNotes(asked[0], VAULT_SCOPE).length,
  }
  summary.passed =
    indexed.notes > 0 &&
    results.every((result) => result.hits > 0) &&
    (summary.afterForget as { notes: number; hits: number }).notes === 0 &&
    (summary.afterForget as { notes: number; hits: number }).hits === 0
  if (!summary.passed) process.exitCode = 1
} catch (error) {
  summary.passed = false
  summary.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  detail.summary = summary
  mkdirSync('verification/private', { recursive: true })
  writeFileSync('verification/private/vault-recall.json', JSON.stringify(detail, null, 2))
  writeFileSync('verification/vault-recall.json', JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  vault.stop()
  models.stop()
  store.close()
  rmSync(directory, { recursive: true, force: true })
}
