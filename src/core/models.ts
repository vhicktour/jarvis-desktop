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
import { record } from './log'
import { MODELS } from '../shared/defaults'
import type { ModelRecord, QualificationResult } from '../shared/contracts'
import { safeError } from './util'

export class Models {
  process?: JsonProcess
  records = structuredClone(MODELS)
  private qualifying?: { id: string; controller: AbortController }
  private starting?: Promise<boolean>
  /** Why the runtime is not up, when it is not. Without this the interface can only shrug. */
  failure?: string
  /** Whether the runtime has said what is installed and qualified. Before that, nothing is known. */
  ready = false
  /** How long first contact may take before the worker is asked again. Cold bundles are slow. */
  patience = 60_000
  private stopping = false
  private diagnostics: string[] = []
  // The worker is the authority on which model adapters it can load.
  private runnable: string[] = []
  constructor(
    private dataDir: string,
    private workersDir: string,
    private changed: () => void,
    private message: (message: any) => void,
  ) {}
  start(): Promise<boolean> {
    if (this.starting) return this.starting
    if (this.process && this.ready) return Promise.resolve(true)
    const starting = this.startRuntime().finally(() => {
      if (this.starting === starting) this.starting = undefined
    })
    this.starting = starting
    return starting
  }
  private async startRuntime() {
    this.ready = false
    this.stopping = false
    this.diagnostics = []
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
      this.ready = false
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
      this.runnable = Array.isArray(info?.models) ? info.models : []
      this.failure = undefined
      await this.refresh()
      this.ready = true
      this.changed()
    } catch (error) {
      this.log(`Giving up on the runtime: ${safeError(error)}`)
      worker.stop()
      if (this.process === worker) this.process = undefined
      this.ready = false
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
    record(this.dataDir, line)
  }
  private explain(reason: string) {
    return [reason, ...this.diagnostics].join(' · ').slice(0, 600)
  }
  /** Load what a spoken turn needs before it is needed; the first exchange is the slow one. */
  async warm(roles = ['asr', 'reasoning', 'tts', 'embedding'], signal?: AbortSignal) {
    if (!this.process) return
    const began = Date.now()
    let warmed = 0
    for (const role of roles) {
      signal?.throwIfAborted()
      const result = await this.process.request('models.warm', { roles: [role] }, 600_000, signal)
      warmed += result?.warmed?.length ?? 0
    }
    this.log(`Warmed ${warmed} roles in ${((Date.now() - began) / 1000).toFixed(1)} s.`)
  }
  async refresh() {
    if (!this.process) return
    const manifests = await this.process.request('models.status')
    this.records = this.records.map((model) => ({
      ...model,
      status: manifests[model.id] ? 'installed' : 'absent',
      revision: manifests[model.id]?.revision,
      qualified: manifests[model.id]?.qualified ?? false,
      installable: this.runnable.includes(model.id),
      checking: this.qualifying?.id === model.id,
      error:
        manifests[model.id]?.qualified === false
          ? manifests[model.id]?.qualification?.detail
          : undefined,
    }))
    this.changed()
  }
  async install(id: string) {
    const model = this.records.find((m) => m.id === id)
    if (!model) throw new Error('Unknown model.')
    if (!this.process) throw new Error('Install the local runtime before downloading models.')
    if (!model.installable)
      throw new Error('This research profile needs a Mac adapter before it can be installed.')
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
    if (this.qualifying?.id === id) throw new Error(`${model.name} is already being checked.`)
    if (this.qualifying) throw new Error('Wait for the current model check to finish.')
    const controller = new AbortController()
    this.qualifying = { id, controller }
    model.checking = true
    model.error = undefined
    this.changed()
    try {
      // Checks render their own fixtures and load a second model, so they outlast a request.
      const result = await this.request<QualificationResult>(
        'model.qualify',
        { id },
        controller.signal,
        900_000,
      )
      await this.refresh()
      return result
    } catch (error) {
      const current = this.records.find((record) => record.id === id)!
      if (controller.signal.aborted) {
        const cancelled = new Error(
          'Check stopped so Jarvis can answer you. Run it again when the conversation is finished.',
        )
        cancelled.name = 'AbortError'
        throw cancelled
      }
      current.error = safeError(error)
      throw new Error(current.error)
    } finally {
      this.qualifying = undefined
      const current = this.records.find((record) => record.id === id)
      if (current) current.checking = false
      this.changed()
    }
  }
  /** A foreground conversation should not wait behind a model benchmark. */
  cancelCheck() {
    this.qualifying?.controller.abort()
  }
  request<T = any>(method: string, params: unknown, signal?: AbortSignal, timeout = 300_000) {
    if (!this.process)
      throw new Error(
        this.failure ??
          'The local model runtime is unavailable. Open Settings → Local models to start it.',
      )
    return this.process.request<T>(method, params, timeout, signal)
  }
  /** Fire and forget: audio frames and the like, which a runtime that is down simply never hears. */
  notify(method: string, params: unknown) {
    try {
      this.process?.notify(method, params)
    } catch {
      /* The worker is gone; the next request says so. */
    }
  }
  has(id: string) {
    return this.records.some((m) => m.id === id && m.status === 'installed')
  }
  qualified(id: string) {
    return this.records.some((m) => m.id === id && m.status === 'installed' && m.qualified)
  }
  stop() {
    this.stopping = true
    this.ready = false
    this.cancelCheck()
    this.process?.stop()
  }
}
