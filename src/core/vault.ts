import { readdir, readFile, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import type { Store } from './store'
import type { Models } from './models'
import type { VaultStatus } from '../shared/contracts'
import { hash, invariant, now, safeError } from './util'

/** Notes are the person's own knowledge, so they join recall in the personal scope. */
export const VAULT_SCOPE = 'personal'
export const VAULT_SETTING = 'vault'
const MAX_NOTES = 5000
const MAX_NOTE_BYTES = 512 * 1024
const MAX_DEPTH = 12
const CHUNK_CHARS = 1200
const CHUNK_LIMIT = 4000
const EMBED_BATCH = 16
const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules'])
// Anything that reads like a credential stays out of the index, and so out of every prompt.
const SECRET =
  /sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ya29\.[A-Za-z0-9_-]{20,}|-----BEGIN[A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S{8,}/i

type Persisted = { path: string; lastSyncedAt?: string; skipped: number }

export function looksSecret(text: string) {
  return SECRET.test(text)
}
export function splitFrontmatter(text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/)
  return match
    ? { frontmatter: match[1], body: text.slice(match[0].length) }
    : { frontmatter: '', body: text }
}
export function noteTitle(path: string, body: string, frontmatter: string) {
  const declared = frontmatter
    .match(/^title:[^\S\r\n]*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  const heading = body.match(/^#[^\S\r\n]+(.+)$/m)?.[1]?.trim()
  return (declared || heading || basename(path, extname(path))).slice(0, 200)
}
/** Split on headings so a recalled excerpt carries the section it came from. */
export function chunkNote(body: string, limit = CHUNK_CHARS) {
  const chunks: { heading: string; text: string }[] = []
  let heading = ''
  let buffer: string[] = []
  let length = 0
  const flush = () => {
    const text = buffer.join('\n').trim()
    buffer = []
    length = 0
    if (text) chunks.push({ heading, text: text.slice(0, CHUNK_LIMIT) })
  }
  for (const line of body.split(/\r?\n/)) {
    const found = line.match(/^#{1,6}[^\S\r\n]+(.+)$/)
    if (found) {
      flush()
      heading = found[1].trim().slice(0, 200)
      continue
    }
    buffer.push(line)
    length += line.length + 1
    // Prefer a paragraph break, but never let an unbroken table grow without bound.
    if (length >= limit && (!line.trim() || length >= limit * 3)) flush()
  }
  flush()
  return chunks
}
/** Counts every note it sees but returns at most MAX_NOTES, so a trim is never silent. */
async function walk(root: string, dir: string, found: string[] = [], depth = 0) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    // Symlinks report as neither file nor directory here, so the walk stays inside the vault.
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) total += (await walk(root, full, found, depth + 1)).total
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      total++
      if (found.length < MAX_NOTES) found.push(relative(root, full))
    }
  }
  return { paths: found, total }
}

export class VaultIndex {
  private watcher?: FSWatcher
  private debounce?: NodeJS.Timeout
  private syncing = false
  private again = false
  private stopped = false
  private stage?: string
  private failure?: string
  // Counted once per change: the snapshot asks for this many times a second.
  private summary: ReturnType<Store['noteSummary']>
  constructor(
    private store: Store,
    private models: Models,
    private changed: () => void,
  ) {
    this.summary = store.noteSummary()
  }

  private saved() {
    return this.store.getSetting<Persisted | null>(VAULT_SETTING, null) ?? undefined
  }
  private publish() {
    this.summary = this.store.noteSummary()
    this.changed()
  }
  status(): VaultStatus {
    const saved = this.saved()
    return {
      ...this.summary,
      path: saved?.path,
      scope: VAULT_SCOPE,
      skipped: saved?.skipped ?? 0,
      syncing: this.syncing,
      stage: this.stage,
      lastSyncedAt: saved?.lastSyncedAt,
      error: this.failure,
    }
  }
  /** Restart watching a folder chosen in an earlier session; never index without one. */
  restore() {
    if (!this.saved()) return
    this.observe()
    return this.sync()
  }
  async connect(path: string) {
    const info = await stat(path).catch(() => null)
    invariant(info?.isDirectory(), 'Choose the folder that holds your notes.')
    const previous = this.saved()
    if (previous && previous.path !== path) this.store.clearNotes()
    this.store.setSetting(VAULT_SETTING, { path, skipped: 0 })
    this.failure = undefined
    this.observe()
    this.publish()
    // Indexing runs behind the returned status; a first pass outlives any request timeout.
    return this.status()
  }
  forget() {
    this.release()
    this.store.clearNotes()
    this.store.setSetting(VAULT_SETTING, null)
    this.failure = undefined
    this.publish()
    return true
  }
  async sync() {
    invariant(this.saved(), 'Choose a notes folder first.')
    if (this.syncing) {
      this.again = true
      return this.status()
    }
    this.syncing = true
    this.failure = undefined
    try {
      do {
        this.again = false
        const saved = this.saved()
        if (!saved) break
        await this.index(saved.path)
      } while (this.again && !this.stopped)
    } catch (error) {
      this.failure = safeError(error)
    } finally {
      this.syncing = false
      this.stage = undefined
      this.changed()
    }
    return this.status()
  }
  private async index(root: string) {
    this.stage = 'Reading your notes'
    this.changed()
    const { paths, total } = await walk(root, root)
    const digest = this.store.noteDigest()
    // Notes past the folder limit are reported, never dropped without a count.
    let skipped = total - paths.length
    let read = 0
    for (const path of paths) {
      if (this.stopped) return
      const full = join(root, path)
      const info = await stat(full).catch(() => null)
      if (!info?.isFile() || info.size > MAX_NOTE_BYTES) {
        skipped++
        continue
      }
      const raw = await readFile(full, 'utf8')
      const contentHash = hash(raw)
      if (digest.get(path) === contentHash) continue
      const { frontmatter, body } = splitFrontmatter(raw)
      const all = chunkNote(body)
      const chunks = all.filter((chunk) => !looksSecret(chunk.text))
      this.store.saveNote(
        {
          path,
          title: noteTitle(path, body, frontmatter),
          scope: VAULT_SCOPE,
          contentHash,
          bytes: info.size,
          // Recorded per note, so an incremental pass still reports the whole index.
          redacted: all.length - chunks.length,
        },
        chunks,
      )
      if (++read % 20 === 0) {
        this.stage = `Reading your notes (${read} changed)`
        this.publish()
      }
    }
    const present = new Set(paths)
    const removed = [...digest.keys()].filter((path) => !present.has(path))
    if (removed.length) this.store.removeNotes(removed)
    this.store.setSetting(VAULT_SETTING, { path: root, lastSyncedAt: now(), skipped })
    this.publish()
    await this.embed()
  }
  private async embed() {
    const model = this.models.records.find((item) => item.id === 'embedding')
    if (model?.status !== 'installed' || !model.revision) return
    let revision = model.revision
    for (let pass = 0; pass < 2000 && !this.stopped; pass++) {
      const pending = this.store.staleNoteChunks(revision, EMBED_BATCH)
      if (!pending.length) return
      this.stage = 'Learning your notes'
      this.changed()
      const result = await this.models.request('embed', {
        texts: pending.map((chunk) => chunk.text),
      })
      invariant(
        Array.isArray(result.vectors) && result.vectors.length === pending.length,
        'The embedding model returned an unexpected batch.',
      )
      pending.forEach((chunk, index) =>
        this.store.embedNote(chunk.id, result.revision, result.vectors[index]),
      )
      // Trust the revision that was actually written, so a model change still converges.
      revision = result.revision
      this.publish()
    }
  }
  private observe() {
    this.release()
    const saved = this.saved()
    if (!saved) return
    try {
      const watcher = (this.watcher = watch(saved.path, { recursive: true }, (_event, name) => {
        if (!name || !name.toLowerCase().endsWith('.md')) return
        if (name.split(/[\\/]/).some((part) => part.startsWith('.') || SKIP.has(part))) return
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => {
          void this.sync().catch(() => {})
        }, 2500)
      }))
      watcher.on('error', (error) => {
        this.failure = safeError(error)
        this.changed()
      })
    } catch (error) {
      this.failure = safeError(error)
    }
  }
  private release() {
    this.watcher?.close()
    this.watcher = undefined
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = undefined
  }
  stop() {
    this.stopped = true
    this.release()
  }
}
