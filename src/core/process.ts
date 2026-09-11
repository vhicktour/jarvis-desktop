import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { MAX_MESSAGE_BYTES } from '../shared/contracts'
import { safeError, uid } from './util'

/** Bounded NDJSON transport; diagnostics never share the protocol stream. */
export class JsonProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private sequence = 0
  constructor(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    super()
    this.child = spawn(command, args, {
      ...options,
      stdio: 'pipe',
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      let end: number
      while ((end = this.buffer.indexOf(10)) >= 0) {
        if (end > MAX_MESSAGE_BYTES) {
          this.fail(new Error('Worker exceeded the message limit.'))
          this.stop()
          return
        }
        const line = this.buffer.subarray(0, end).toString('utf8')
        this.buffer = this.buffer.subarray(end + 1)
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line)
          const request =
            message.id === undefined ? undefined : this.pending.get(String(message.id))
          if (request && !message.method) {
            clearTimeout(request.timer)
            this.pending.delete(String(message.id))
            // A reply carrying an error key failed, even when the text of it is empty: Python's
            // StopIteration stringifies to nothing, and treating that as success resolves the
            // request with undefined and hides the failure from whoever asked.
            if (message.error !== undefined || message.ok === false)
              request.reject(
                new Error(
                  (typeof message.error === 'string' ? message.error : message.error?.message) ||
                    'The worker failed without saying why.',
                ),
              )
            else request.resolve(message.result ?? message.value)
          } else this.emit('message', message)
        } catch {
          this.fail(new Error('Worker sent an invalid protocol message.'))
          this.stop()
          return
        }
      }
      if (this.buffer.length > MAX_MESSAGE_BYTES) {
        this.fail(new Error('Worker exceeded the message limit.'))
        this.stop()
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) =>
      this.emit('diagnostic', safeError(chunk.toString('utf8'))),
    )
    this.child.on('error', (error) => this.fail(error))
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`Worker exited (${code ?? signal ?? 'signal'}).`))
      this.emit('exit', code, signal)
    })
  }
  request<T = any>(
    method: string,
    params: unknown = {},
    timeout = 30_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.pending.size >= 128)
      return Promise.reject(
        new Error('The worker queue is full. Try again when the current operation finishes.'),
      )
    const id = uid()
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Cancelled.'))
      const abort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        try {
          this.notify('cancel', { requestId: id })
        } catch {
          /* The worker may already have exited. */
        }
        reject(new Error('Cancelled.'))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', abort)
        try {
          this.notify('cancel', { requestId: id })
        } catch {
          /* Worker may already have exited. */
        }
        reject(new Error(`${method} timed out.`))
      }, timeout)
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          signal?.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        },
      })
      try {
        this.send({ version: 1, id, method, params, sequence: ++this.sequence })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
    })
  }
  notify(method: string, params: unknown = {}) {
    this.send({ version: 1, method, params, sequence: ++this.sequence })
  }
  respond(id: string | number, result: unknown) {
    this.send({ id, result })
  }
  send(value: unknown) {
    const data = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES)
      throw new Error('Message is too large. Use an artifact reference.')
    if (this.child.killed || !this.child.stdin.writable) throw new Error('Worker is unavailable.')
    this.child.stdin.write(data)
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
  stop() {
    this.killGroup('SIGTERM')
    const timer = setTimeout(() => {
      this.killGroup('SIGKILL')
    }, 1500)
    timer.unref()
  }
  async stopAndWait() {
    this.killGroup('SIGTERM')
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        this.killGroup('SIGKILL')
        resolve()
      }, 1500),
    )
  }
  private killGroup(signal: NodeJS.Signals) {
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal)
      else this.child.kill(signal)
    } catch {
      /* The group has already exited. */
    }
  }
}
