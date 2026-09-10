import { createRequire } from 'node:module'
import type CipherDatabase from '../../node_modules/better-sqlite3-multiple-ciphers/index'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  Settings,
  Task,
  MemoryRecord,
  type Approval,
  type TaskEvent,
  type ActionReceipt,
  type Message,
  type Project,
  type Routine,
} from '../shared/contracts'
import { now, uid, invariant } from './util'

// The package ships declarations but omits them from its exports map.
const Database = createRequire(import.meta.url)(
  'better-sqlite3-multiple-ciphers',
) as typeof CipherDatabase

export class Store {
  readonly db: InstanceType<typeof CipherDatabase>
  constructor(path: string, key: Buffer) {
    invariant(key.byteLength === 32, 'The database requires a 256-bit encryption key.')
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      chmodSync(dirname(path), 0o700)
    }
    this.db = new Database(path)
    try {
      this.db.pragma("cipher = 'sqlcipher'")
      this.db.pragma('legacy = 4')
      this.db.key(key)
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('secure_delete = ON')
      this.db.pragma('busy_timeout = 5000')
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = FULL')
      this.migrate()
      if (path !== ':memory:') chmodSync(path, 0o600)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number
    invariant(version <= 1, 'This database was created by a newer version of Jarvis.')
    if (version === 1) return
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, scope TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE task_events (id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task_id, sequence));
        CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, decision TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE effects (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, approval_id TEXT REFERENCES approvals(id), idempotency_key TEXT UNIQUE NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE receipts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL);
        CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, scope UNINDEXED, text);
        CREATE TABLE memory_chunks (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, model_revision TEXT NOT NULL, dimension INTEGER NOT NULL, vector BLOB NOT NULL);
        CREATE TABLE memory_lineage (source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, derived_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, PRIMARY KEY(source_id, derived_id));
        CREATE TABLE projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE routines (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE INDEX task_scope_updated ON tasks(scope, updated_at);
        CREATE INDEX message_scope_created ON messages(scope, created_at);
        CREATE INDEX memory_scope_active ON memories(scope, active);
        PRAGMA user_version = 1;
      `)
    })()
  }

  close() {
    if (!this.db.open) return
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.close()
  }
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT payload FROM settings WHERE key = ?').get(key) as
      { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as T) : fallback
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload',
      )
      .run(key, JSON.stringify(value))
  }
  settings() {
    return Settings.parse(this.getSetting('preferences', {}))
  }
  getTask(id: string): Task {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as
      { payload: string } | undefined
    invariant(row, 'This task is no longer available.')
    return Task.parse(JSON.parse(row.payload))
  }
  tasks(limit = 80): Task[] {
    return this.rows('SELECT payload FROM tasks ORDER BY updated_at DESC LIMIT ?', limit).map(
      (value) => Task.parse(value),
    )
  }
  insertTask(task: Task) {
    Task.parse(task)
    this.db
      .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        task.id,
        task.revision,
        task.state,
        task.scope,
        task.createdAt,
        task.updatedAt,
        JSON.stringify(task),
      )
  }
  updateTask(
    id: string,
    revision: number,
    change: (task: Task) => Task,
    event: { type: string; message: string; data?: Record<string, unknown> },
  ): Task {
    return this.db.transaction(() => {
      const current = this.getTask(id)
      invariant(current.revision === revision, 'This task changed. Refresh before trying again.')
      const next = Task.parse(change(structuredClone(current)))
      invariant(
        next.id === id && next.scope === current.scope,
        'A task cannot change its identity or scope.',
      )
      next.updatedAt = now()
      const result = this.db
        .prepare(
          'UPDATE tasks SET revision=?, state=?, updated_at=?, payload=? WHERE id=? AND revision=?',
        )
        .run(next.revision, next.state, next.updatedAt, JSON.stringify(next), id, revision)
      invariant(result.changes === 1, 'A newer task revision is already active.')
      this.appendEvent(id, next.revision, event)
      return next
    })()
  }
  appendEvent(
    taskId: string,
    revision: number,
    event: { type: string; message: string; data?: Record<string, unknown> },
  ) {
    const { sequence } = this.db
      .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM task_events WHERE task_id=?')
      .get(taskId) as { sequence: number }
    const value: TaskEvent = { id: uid(), taskId, revision, sequence, timestamp: now(), ...event }
    this.db
      .prepare('INSERT INTO task_events VALUES (?, ?, ?, ?)')
      .run(value.id, taskId, sequence, JSON.stringify(value))
    return value
  }
  events(taskId?: string): TaskEvent[] {
    return taskId
      ? (this.rows(
          'SELECT payload FROM task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 200',
          taskId,
        ).reverse() as TaskEvent[])
      : []
  }
  saveApproval(value: Approval) {
    this.db
      .prepare(
        'INSERT INTO approvals VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET decision=excluded.decision, payload=excluded.payload',
      )
      .run(value.id, value.proposal.taskId, value.decision, JSON.stringify(value))
  }
  approvals(): Approval[] {
    return this.rows("SELECT payload FROM approvals WHERE decision='pending'") as Approval[]
  }
  approval(id: string): Approval | undefined {
    return this.rows('SELECT payload FROM approvals WHERE id=?', id)[0] as Approval | undefined
  }
  revokeApprovals(taskId: string) {
    for (const approval of this.rows(
      "SELECT payload FROM approvals WHERE task_id=? AND decision IN ('pending','approved')",
      taskId,
    ) as Approval[])
      this.saveApproval({ ...approval, decision: 'expired' })
  }
  intent(
    taskId: string,
    approvalId: string | null,
    idempotencyKey: string,
    payload: unknown,
  ): string {
    const id = uid()
    this.db
      .prepare('INSERT INTO effects VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, taskId, approvalId, idempotencyKey, 'intent', JSON.stringify(payload))
    return id
  }
  finishEffect(id: string, state: 'succeeded' | 'failed' | 'uncertain', payload: unknown) {
    this.db
      .prepare('UPDATE effects SET state=?, payload=? WHERE id=?')
      .run(state, JSON.stringify(payload), id)
  }
  uncertainEffects(taskId: string) {
    return this.db
      .prepare(
        "SELECT id, state, payload FROM effects WHERE task_id=? AND state IN ('intent', 'uncertain')",
      )
      .all(taskId) as { id: string; state: string; payload: string }[]
  }
  effects(taskId: string) {
    return (
      this.db.prepare('SELECT id, state, payload FROM effects WHERE task_id=?').all(taskId) as {
        id: string
        state: string
        payload: string
      }[]
    ).map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
  }
  saveReceipt(receipt: ActionReceipt) {
    this.db
      .prepare('INSERT INTO receipts VALUES (?, ?, ?, ?)')
      .run(receipt.id, receipt.taskId, receipt.createdAt, JSON.stringify(receipt))
  }
  receipts(): ActionReceipt[] {
    return this.rows(
      'SELECT payload FROM receipts ORDER BY created_at DESC LIMIT 80',
    ) as ActionReceipt[]
  }
  saveMessage(message: Message) {
    const { streaming: _, ...persistent } = message
    this.db
      .prepare(
        'INSERT INTO messages VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(message.id, message.scope, message.createdAt, JSON.stringify(persistent))
  }
  messages(scope: string): Message[] {
    return (
      this.rows(
        'SELECT payload FROM messages WHERE scope=? ORDER BY created_at DESC LIMIT 100',
        scope,
      ) as Message[]
    ).reverse()
  }
  memory(id: string): MemoryRecord | undefined {
    const item = this.rows('SELECT payload FROM memories WHERE id=?', id)[0]
    return item ? MemoryRecord.parse(item) : undefined
  }
  memories(scope?: string): MemoryRecord[] {
    const query = scope
      ? 'SELECT payload FROM memories WHERE active=1 AND scope=? LIMIT 1000'
      : 'SELECT payload FROM memories WHERE active=1 LIMIT 1000'
    return this.rows(query, ...(scope ? [scope] : [])).map((value) => MemoryRecord.parse(value))
  }
  saveMemory(record: MemoryRecord) {
    MemoryRecord.parse(record)
    this.db.transaction(() => {
      if (record.supersedes) {
        const previous = this.memory(record.supersedes)
        invariant(
          previous && previous.scope === record.scope,
          'The previous memory belongs to a different scope.',
        )
        this.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(record.supersedes)
        this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(record.supersedes)
      }
      this.db
        .prepare(
          'INSERT INTO memories VALUES (?, ?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, payload=excluded.payload',
        )
        .run(record.id, record.scope, record.text, JSON.stringify(record))
      this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(record.id)
      if (record.reviewState === 'approved')
        this.db
          .prepare('INSERT INTO memory_fts VALUES (?, ?, ?)')
          .run(record.id, record.scope, record.text)
      if (record.supersedes)
        this.db
          .prepare('INSERT OR IGNORE INTO memory_lineage VALUES (?, ?)')
          .run(record.supersedes, record.id)
      if (record.sourceIds.length) {
        const sources = this.db
          .prepare(
            `SELECT id FROM memories WHERE scope=? AND id IN (${record.sourceIds.map(() => '?').join(',')})`,
          )
          .all(record.scope, ...record.sourceIds) as { id: string }[]
        for (const source of sources)
          if (source.id !== record.id)
            this.db
              .prepare('INSERT OR IGNORE INTO memory_lineage VALUES (?, ?)')
              .run(source.id, record.id)
      }
      this.db.prepare('DELETE FROM memory_chunks WHERE memory_id=?').run(record.id)
    })()
  }
  forget(id: string) {
    let removedIds: string[] = []
    this.db.transaction(() => {
      // Forget the correction history as well as all records derived from it.
      let root = this.memory(id)
      const visited = new Set<string>()
      while (root?.supersedes && !visited.has(root.id)) {
        visited.add(root.id)
        root = this.memory(root.supersedes) ?? root
        if (visited.has(root.id)) break
      }
      const descendants = this.db
        .prepare(
          'WITH RECURSIVE derived(id) AS (SELECT ? UNION SELECT memory_lineage.derived_id FROM memory_lineage JOIN derived ON memory_lineage.source_id=derived.id) SELECT id FROM derived',
        )
        .all(root?.id ?? id) as { id: string }[]
      removedIds = descendants.map((item) => item.id)
      const removeSearch = this.db.prepare('DELETE FROM memory_fts WHERE id=?')
      const removeRecord = this.db.prepare('DELETE FROM memories WHERE id=?')
      for (const item of descendants) {
        removeSearch.run(item.id)
        removeRecord.run(item.id)
      }
      const removed = new Set(removedIds)
      const deleteMessage = this.db.prepare('DELETE FROM messages WHERE id=?')
      for (const message of this.rows('SELECT payload FROM messages') as Message[]) {
        if (message.sources?.some((source) => removed.has(source.id))) deleteMessage.run(message.id)
      }
    })()
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    return removedIds
  }
  exportData() {
    return {
      version: 1,
      exportedAt: now(),
      memories: this.rows('SELECT payload FROM memories'),
      tasks: this.rows('SELECT payload FROM tasks'),
      events: this.rows('SELECT payload FROM task_events'),
      approvals: this.rows('SELECT payload FROM approvals'),
      effects: this.db.prepare('SELECT id, task_id, state, payload FROM effects').all(),
      receipts: this.rows('SELECT payload FROM receipts'),
      routines: this.rows('SELECT payload FROM routines'),
      conversations: this.rows('SELECT payload FROM messages ORDER BY created_at'),
    }
  }
  searchMemory(
    query: string,
    scope: string,
    vector?: { values: number[]; revision: string },
  ): MemoryRecord[] {
    const words = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20) ?? []
    const ranks = new Map<string, number>()
    if (words.length) {
      const matches = this.db
        .prepare(
          'SELECT id FROM memory_fts WHERE memory_fts MATCH ? AND scope=? ORDER BY rank LIMIT 30',
        )
        .all(words.map((word) => '"' + word.replaceAll('"', '""') + '"').join(' OR '), scope) as {
        id: string
      }[]
      matches.forEach((item, index) => ranks.set(item.id, 1 / (60 + index)))
    }
    if (vector) {
      const rows = this.db
        .prepare(
          'SELECT c.memory_id, c.vector FROM memory_chunks c JOIN memories m ON c.memory_id=m.id WHERE m.scope=? AND m.active=1 AND c.model_revision=? AND c.dimension=? LIMIT 20000',
        )
        .all(scope, vector.revision, vector.values.length) as {
        memory_id: string
        vector: Buffer
      }[]
      const queryNorm = Math.sqrt(vector.values.reduce((s, n) => s + n * n, 0)) || 1
      const matches = rows
        .map((row) => {
          const values = new Float32Array(
            row.vector.buffer.slice(
              row.vector.byteOffset,
              row.vector.byteOffset + row.vector.byteLength,
            ),
          )
          let dot = 0,
            norm = 0
          values.forEach((n, index) => {
            dot += n * vector.values[index]
            norm += n * n
          })
          return { id: row.memory_id, score: dot / (queryNorm * Math.sqrt(norm || 1)) }
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30)
      matches.forEach((item, index) =>
        ranks.set(item.id, (ranks.get(item.id) ?? 0) + 1 / (60 + index)),
      )
    }
    const records = new Map(
      this.memories(scope)
        .filter((m) => m.reviewState === 'approved')
        .map((m) => [m.id, m]),
    )
    return [...ranks]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .flatMap(([id]) => (records.has(id) ? [records.get(id)!] : []))
  }
  embedMemory(id: string, revision: string, vector: number[]) {
    invariant(
      vector.length > 0 && vector.length <= 4096 && vector.every(Number.isFinite),
      'Invalid embedding.',
    )
    const buffer = Buffer.from(new Float32Array(vector).buffer)
    this.db
      .prepare(
        'INSERT INTO memory_chunks VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model_revision=excluded.model_revision, dimension=excluded.dimension, vector=excluded.vector',
      )
      .run(id, id, revision, vector.length, buffer)
  }
  projects(): Project[] {
    return this.rows('SELECT payload FROM projects') as Project[]
  }
  saveProject(project: Project) {
    this.db
      .prepare(
        'INSERT INTO projects VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(project.id, JSON.stringify(project))
  }
  removeProject(id: string) {
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id)
  }
  routines(): Routine[] {
    return this.rows('SELECT payload FROM routines') as Routine[]
  }
  saveRoutine(routine: Routine) {
    this.db
      .prepare(
        'INSERT INTO routines VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(routine.id, JSON.stringify(routine))
  }
  removeRoutine(id: string) {
    this.db.prepare('DELETE FROM routines WHERE id=?').run(id)
  }
  purgeExpired(at = Date.now()) {
    const settings = this.settings()
    const cutoff = (days: number) => new Date(at - days * 86_400_000).toISOString()
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM messages WHERE created_at < ?')
        .run(cutoff(settings.transcriptDays))
      this.db
        .prepare(
          "DELETE FROM tasks WHERE updated_at < ? AND state IN ('completed','cancelled','failed')",
        )
        .run(cutoff(settings.receiptDays))
    })()
  }
  private rows(sql: string, ...parameters: unknown[]): unknown[] {
    return (this.db.prepare(sql).all(...parameters) as { payload: string }[]).map((row) =>
      JSON.parse(row.payload),
    )
  }
}
