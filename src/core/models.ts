import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { JsonProcess } from './process'
import { MODELS } from '../shared/defaults'
import type { ModelRecord, QualificationResult } from '../shared/contracts'
import { safeError } from './util'

export class Models {
  process?: JsonProcess
  records = structuredClone(MODELS)
  private qualifying = new Set<string>()
  /** Why the runtime is not up, when it is not. Without this the interface can only shrug. */
  failure?: string
  /** How long first contact may take before the worker is asked again. Cold bundles are slow. */
  patience = 60_000
  private stopping = false
  private diagnostics: string[] = []
  // The worker is the authority on which roles it can load; the interface only reflects it.
  private runnable: string[] = []
  constructor(
    private dataDir: string,
    private workersDir: string,
    private changed: () => void,
    private message: (message: any) => void,
  ) {}
  async start() {
    if (this.process) return true
    const config = join(this.workersDir, 'runtime.json')
    if (!existsSync(config)) return false
    const runtime = JSON.parse(readFileSync(config, 'utf8'))
    const catalog = join(this.dataDir, 'model-catalog.json')
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(catalog, JSON.stringify(MODELS), { mode: 0o600 })
    const worker = (this.process = new JsonProcess(
      join(this.workersDir, runtime.python),
      ['-u', join(this.workersDir, 'models.py'), this.dataDir, catalog],
      {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: this.dataDir,
          LANG: 'en_US.UTF-8',
          HF_HOME: join(this.dataDir, 'model-cache'),
          HF_HUB_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          DO_NOT_TRACK: '1',
          TOKENIZERS_PARALLELISM: 'false',
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          NUMBA_CACHE_DIR: join(this.dataDir, 'model-cache/numba'),
        },
      },
    ))
    this.log(`Starting the model runtime (pid ${worker.child.pid ?? 'unknown'}).`)
    this.process.on('message', (message) => this.message(message))
    // Python reports why it could not start on stderr; keep the last of it to explain a failure.
    worker.on('diagnostic', (line: string) => {
      const text = String(line).trim()
      if (text) this.diagnostics = [...this.diagnostics, text].slice(-8)
    })
    // A worker that answers and then leaves quietly is the failure to catch: exit 0 is not fine
    // when nobody asked it to stop, and it arrives with no stderr to explain itself.
    worker.on('exit', (code: number | null, signal: string | null) => {
      if (this.process !== worker) return
      this.process = undefined
      this.log(
        `The runtime process ended (${signal ?? `exit ${code ?? 'unknown'}`})${this.stopping ? ', because Jarvis asked it to' : ', unasked'}.`,
      )
      if (!this.stopping)
        this.failure = this.explain(
          `The local model runtime stopped on its own (${signal ?? `exit ${code ?? 'unknown'}`}). Open Settings → Local models to start it again.`,
        )
      this.changed()
    })
    try {
      const began = Date.now()
      const info = await this.greet(worker)
      this.log(`The runtime answered in ${((Date.now() - began) / 1000).toFixed(2)} s.`)
      this.runnable = Array.isArray(info?.roles) ? info.roles : []
      this.failure = undefined
      await this.refresh()
    } catch (error) {
      this.log(`Giving up on the runtime: ${safeError(error)}`)
      worker.stop()
      if (this.process === worker) this.process = undefined
      this.failure = this.explain(safeError(error))
      this.changed()
      throw error
    }
    return true
  }
  /**
   * First contact can be slow. A freshly installed bundle pays for signature validation on every
   * page it imports, which measured 13.8 s against 0.15 s once warm, and a machine under load pays
   * more. Being slow to answer is not a reason to kill a worker that is still coming up, so a
   * living worker is asked a second time before the runtime is given up on.
   */
  private async greet(worker: JsonProcess) {
    try {
      return await worker.request('ping', {}, this.patience)
    } catch (error) {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) throw error
      this.log(`First ping went unanswered (${safeError(error)}); asking once more.`)
      return await worker.request('ping', {}, this.patience)
    }
  }
  /**
   * A packaged application that loses its runtime cannot be watched live, so the lifecycle is
   * written down. Bounded, because a log that fills the disk is its own failure.
   */
  private log(line: string) {
    try {
      const file = join(this.dataDir, 'runtime.log')
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 64_000)
        writeFileSync(file, '', { mode: 0o600 })
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
    } catch {
      /* Diagnostics must never be the reason the runtime cannot start. */
    }
  }
  private explain(reason: string) {
    return [reason, ...this.diagnostics].join(' · ').slice(0, 600)
  }
  async refresh() {
    if (!this.process) return
    const manifests = await this.process.request('models.status')
    this.records = this.records.map((model) => ({
      ...model,
      status: manifests[model.id] ? 'installed' : 'absent',
      revision: manifests[model.id]?.revision,
      qualified: manifests[model.id]?.qualified ?? false,
      installable: this.runnable.includes(model.role),
      error: undefined,
    }))
    this.changed()
  }
  async install(id: string) {
    const model = this.records.find((m) => m.id === id)
    if (!model) throw new Error('Unknown model.')
    if (!this.process) throw new Error('Install the local runtime before downloading models.')
    if (this.records.some((m) => m.status === 'installing'))
      throw new Error('A model download is already in progress.')
    model.status = 'installing'
    model.error = undefined
    this.changed()
    try {
      await this.process.request('model.install', { id }, 3_600_000)
      await this.refresh()
    } catch (error) {
      model.status = 'error'
      model.error = safeError(error)
      this.changed()
    }
  }
  /** Observes this revision’s actual behavior on this Mac and records the result. */
  async qualify(id: string) {
    const model = this.records.find((m) => m.id === id)
    if (!model) throw new Error('Unknown model.')
    if (this.qualifying.has(id)) throw new Error(`${model.name} is already being checked.`)
    this.qualifying.add(id)
    try {
      // Checks render their own fixtures and load a second model, so they outlast a request.
      const result = await this.request<QualificationResult>(
        'model.qualify',
        { id },
        undefined,
        900_000,
      )
      await this.refresh()
      return result
    } finally {
      this.qualifying.delete(id)
    }
  }
  request<T = any>(method: string, params: unknown, signal?: AbortSignal, timeout = 300_000) {
    if (!this.process)
      throw new Error(
        'Your local model runtime is not installed. Open Settings → Models to set it up.',
      )
    return this.process.request<T>(method, params, timeout, signal)
  }
  has(id: string) {
    return this.records.some((m) => m.id === id && m.status === 'installed')
  }
  qualified(id: string) {
    return this.records.some((m) => m.id === id && m.status === 'installed' && m.qualified)
  }
  stop() {
    this.stopping = true
    this.process?.stop()
  }
}
