import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JsonProcess } from './process'
import { MODELS } from '../shared/defaults'
import type { ModelRecord } from '../shared/contracts'
import { safeError } from './util'

export class Models {
  process?: JsonProcess
  records = structuredClone(MODELS)
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
    this.process.on('message', (message) => this.message(message))
    worker.on('exit', () => {
      if (this.process === worker) this.process = undefined
      this.changed()
    })
    try {
      await worker.request('ping', {}, 60_000)
      await this.refresh()
    } catch (error) {
      worker.stop()
      if (this.process === worker) this.process = undefined
      throw error
    }
    return true
  }
  async refresh() {
    if (!this.process) return
    const manifests = await this.process.request('models.status')
    this.records = this.records.map((model) => ({
      ...model,
      status: manifests[model.id] ? 'installed' : 'absent',
      revision: manifests[model.id]?.revision,
      qualified: manifests[model.id]?.qualified ?? false,
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
  request<T = any>(method: string, params: unknown, signal?: AbortSignal) {
    if (!this.process)
      throw new Error(
        'Your local model runtime is not installed. Open Settings → Models to set it up.',
      )
    return this.process.request<T>(method, params, 300_000, signal)
  }
  has(id: string) {
    return this.records.some((m) => m.id === id && m.status === 'installed')
  }
  stop() {
    this.process?.stop()
  }
}
