import WebSocket from 'ws'
import { invariant } from '../core/util'

export const REALTIME_MODEL = 'gpt-realtime-2.1'
const ENDPOINT = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`
const MAX_BUFFER = 256_000

export type RealtimeCallbacks = {
  phase(phase: 'listening' | 'thinking' | 'speaking'): void
  transcript(id: string, role: 'user' | 'assistant', text: string, final: boolean): void
  begin(): Promise<void>
  audio(pcm: string): Promise<void>
  end(): Promise<void>
  interrupt(): Promise<number>
  tool(name: string, args: unknown): Promise<unknown>
  closed(error?: string): void
  usage(costUsd: number): void
}
export const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'run_task',
    description:
      'Start work the user requested in the selected project. The task engine handles tools, approvals and verification. This only queues work; never say it is finished from this result.',
    parameters: {
      type: 'object',
      properties: { objective: { type: 'string', maxLength: 4000 } },
      required: ['objective'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'task_status',
    description: 'Read current task progress, pending approvals, and verified receipts.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'recall',
    description: 'Recall relevant approved memories and notes from the current project scope.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 500 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const

// Published GPT-Realtime-2.1 token rates. Reported usage can arrive after a response completes.
export function realtimeCost(usage: any): number {
  const input = usage?.input_token_details ?? {}
  const output = usage?.output_token_details ?? {}
  const cached = input.cached_tokens_details ?? {}
  const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0)
  return (
    (Math.max(0, count(input.text_tokens) - count(cached.text_tokens)) * 4 +
      Math.max(0, count(input.audio_tokens) - count(cached.audio_tokens)) * 32 +
      count(input.cached_tokens) * 0.4 +
      count(output.text_tokens) * 24 +
      count(output.audio_tokens) * 64) /
    1_000_000
  )
}

/** Audio stays in the service/native processes; API credentials never enter the renderer. */
export class RealtimeVoice {
  private socket?: WebSocket
  private running = false
  private configured = false
  private serial: Promise<void> = Promise.resolve()
  private response?: string
  private items: { id: string; content: number; startMs: number; durationMs: number }[] = []
  private cancelled = new Set<string>()
  private handledCalls = new Set<string>()
  private text = new Map<string, string>()
  private timer?: NodeJS.Timeout
  private idle?: NodeJS.Timeout
  private heartbeat?: NodeJS.Timeout
  private lastMessage = 0
  private cost = 0
  private rejectStart?: (error: Error) => void
  private inputBytes = 0
  private awaitingTurn = false
  private outputOpen = false
  private turnEpoch = 0
  private completed = new Set<string>()

  constructor(
    private callbacks: RealtimeCallbacks,
    private createSocket = (key: string) =>
      new WebSocket(ENDPOINT, {
        headers: { Authorization: `Bearer ${key}` },
        maxPayload: 1_048_576,
        handshakeTimeout: 15_000,
      }),
  ) {}

  async start(
    apiKey: string,
    options: {
      instructions: string
      maxCostUsd: number
      maxSessionMs: number
      maxTokens: number
      history?: { role: 'user' | 'assistant'; content: string }[]
    },
  ) {
    invariant(!this.running, 'A realtime conversation is already active.')
    invariant(apiKey && options.maxCostUsd > 0, 'Connect OpenAI and set a usage ceiling first.')
    this.running = true
    this.cost = 0
    const socket = (this.socket = this.createSocket(apiKey))
    this.lastMessage = Date.now()
    socket.on('pong', () => {
      this.lastMessage = Date.now()
    })
    socket.on('error', () =>
      this.stop('OpenAI Realtime could not connect. Check the connection and network.'),
    )
    socket.on('close', () => {
      if (this.running)
        this.stop('The realtime connection closed. Start a new conversation to reconnect.')
    })
    this.timer = setTimeout(
      () => this.stop('The voice session reached its time limit.'),
      Math.min(options.maxSessionMs, 600_000),
    )
    this.timer.unref()
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastMessage > 45_000)
        this.stop('The realtime connection stopped responding.')
      else if (socket.readyState === WebSocket.OPEN) socket.ping()
    }, 15_000)
    this.heartbeat.unref()
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => this.stop('OpenAI did not finish configuring the voice session.'),
        20_000,
      )
      this.rejectStart = (error) => {
        clearTimeout(timeout)
        reject(error)
      }
      socket.on('open', () => {
        this.send({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: REALTIME_MODEL,
            instructions: options.instructions,
            output_modalities: ['audio'],
            max_output_tokens: options.maxTokens,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
                noise_reduction: { type: 'near_field' },
                turn_detection: {
                  type: 'semantic_vad',
                  eagerness: 'high',
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'cedar' },
            },
            tools: VOICE_TOOLS,
            tool_choice: 'auto',
          },
        })
      })
      socket.on('message', (raw) => {
        if (!this.running) return
        this.lastMessage = Date.now()
        let event: any
        try {
          event = JSON.parse(raw.toString())
        } catch {
          this.stop('OpenAI returned an invalid voice event.')
          return
        }
        if (event.type === 'session.updated' && !this.configured) {
          this.configured = true
          clearTimeout(timeout)
          this.rejectStart = undefined
          for (const message of (options.history ?? []).slice(-12)) {
            this.send({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: message.role,
                content: [
                  {
                    type: message.role === 'user' ? 'input_text' : 'output_text',
                    text: message.content.slice(0, 1200),
                  },
                ],
              },
            })
          }
          this.armIdle()
          resolve()
        }
        // Barge-in must not wait behind queued audio or a tool call.
        if (event.type === 'input_audio_buffer.speech_started') {
          void this.interruptPlayback().catch(() => this.stop('Audio interruption failed.'))
          return
        }
        const epoch = this.turnEpoch
        this.serial = this.serial
          .then(async () => {
            if (this.running) await this.receive(event, options.maxCostUsd, epoch)
          })
          .catch((error) =>
            this.stop(error instanceof Error ? error.message : 'The realtime audio stream failed.'),
          )
      })
    })
  }

  private send(event: unknown) {
    if (!this.running || this.socket?.readyState !== WebSocket.OPEN) return
    if (this.socket.bufferedAmount > MAX_BUFFER) {
      this.stop('The network cannot keep up with live audio.')
      return
    }
    this.socket.send(JSON.stringify(event))
  }
  append(pcm: string) {
    if (!this.configured || !this.running) return
    const bytes = Buffer.byteLength(pcm, 'base64')
    if (bytes === 0 || bytes > 48_000 || bytes % 2) return
    this.inputBytes += bytes
    this.send({ type: 'input_audio_buffer.append', audio: pcm })
  }
  commit() {
    if (!this.running || this.awaitingTurn || this.inputBytes < 4800) return false
    this.awaitingTurn = true
    this.inputBytes = 0
    this.send({ type: 'input_audio_buffer.commit' })
    this.send({ type: 'response.create' })
    return true
  }
  playbackFinished() {
    if (this.running) this.armIdle()
  }
  private armIdle() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      if (!this.response && !this.awaitingTurn) this.stop()
    }, 20_000)
    this.idle.unref()
  }
  private async interruptPlayback() {
    this.turnEpoch++
    if (this.idle) clearTimeout(this.idle)
    this.awaitingTurn = false
    if (this.response) {
      this.cancelled.add(this.response)
      this.send({ type: 'response.cancel', response_id: this.response })
    }
    const items = this.items
    this.items = []
    this.response = undefined
    this.outputOpen = false
    const interrupted = this.callbacks.interrupt()
    this.callbacks.phase('listening')
    const playedMs = await interrupted
    for (const item of items) {
      if (playedMs >= item.startMs + item.durationMs) continue
      this.send({
        type: 'conversation.item.truncate',
        item_id: item.id,
        content_index: item.content,
        audio_end_ms: Math.max(0, Math.floor(playedMs - item.startMs)),
      })
    }
  }
  private async receive(event: any, budget: number, epoch: number) {
    const type = event.type
    if (type?.startsWith('input_audio_buffer.') && epoch !== this.turnEpoch) return
    if (type === 'response.done') {
      if (this.completed.has(event.response.id)) return
      this.completed.add(event.response.id)
      const cost = realtimeCost(event.response.usage)
      this.cost += cost
      this.callbacks.usage(cost)
      if (this.cost >= budget) {
        this.stop('The voice session reached its reported usage ceiling.')
        return
      }
    }
    if (type?.startsWith('response.') && epoch !== this.turnEpoch) {
      if (type === 'response.created') {
        this.cancelled.add(event.response.id)
        this.send({ type: 'response.cancel', response_id: event.response.id })
      }
      return
    }
    if (type === 'error') {
      if (
        ['response_cancel_not_active', 'input_audio_buffer_commit_empty'].includes(
          event.error?.code,
        )
      )
        return
      throw new Error(
        `OpenAI Realtime: ${String(event.error?.message ?? 'request failed').slice(0, 400)}`,
      )
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.awaitingTurn = true
      this.callbacks.phase('thinking')
    } else if (type === 'input_audio_buffer.committed') {
      this.inputBytes = 0
    } else if (type === 'conversation.item.input_audio_transcription.delta') {
      this.addText(event.item_id, 'user', event.delta ?? '', false)
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      this.text.delete(event.item_id)
      this.callbacks.transcript(event.item_id, 'user', String(event.transcript ?? ''), true)
    } else if (type === 'response.created') {
      this.awaitingTurn = false
      this.response = event.response.id
      if (!this.outputOpen) {
        this.outputOpen = true
        this.items = []
        await this.callbacks.begin()
      }
    } else if (type === 'response.output_audio.delta' && !this.cancelled.has(event.response_id)) {
      this.callbacks.phase('speaking')
      const bytes = Buffer.from(String(event.delta ?? ''), 'base64')
      if (bytes.length % 2) throw new Error('OpenAI returned a partial audio sample.')
      let item = this.items.find(
        (item) => item.id === event.item_id && item.content === (event.content_index ?? 0),
      )
      if (!item) {
        const previous = this.items.at(-1)
        item = {
          id: event.item_id,
          content: event.content_index ?? 0,
          startMs: previous ? previous.startMs + previous.durationMs : 0,
          durationMs: 0,
        }
        this.items.push(item)
      }
      item.durationMs += bytes.length / 48
      for (let offset = 0; offset < bytes.length; offset += 48_000) {
        if (!this.running || epoch !== this.turnEpoch) return
        await this.callbacks.audio(bytes.subarray(offset, offset + 48_000).toString('base64'))
      }
    } else if (
      type === 'response.output_audio_transcript.delta' &&
      !this.cancelled.has(event.response_id)
    ) {
      this.addText(event.item_id, 'assistant', event.delta ?? '', false)
    } else if (
      type === 'response.output_audio_transcript.done' &&
      !this.cancelled.has(event.response_id)
    ) {
      this.text.delete(event.item_id)
      this.callbacks.transcript(event.item_id, 'assistant', String(event.transcript ?? ''), true)
    } else if (type === 'response.done') {
      const response = event.response
      if (this.cancelled.has(response.id)) return
      if (response.status === 'failed')
        throw new Error('The realtime model could not finish this response.')
      if (this.response === response.id) this.response = undefined
      const calls = (response.output ?? []).filter((item: any) => item.type === 'function_call')
      for (const call of calls) {
        if (this.handledCalls.has(call.call_id)) continue
        this.handledCalls.add(call.call_id)
        let output: unknown
        try {
          output = await this.callbacks.tool(call.name, JSON.parse(call.arguments))
        } catch (error) {
          output = { error: error instanceof Error ? error.message : 'The task could not start.' }
        }
        if (!this.running || epoch !== this.turnEpoch) return
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(output).slice(0, 12_000),
          },
        })
      }
      if (calls.length) this.send({ type: 'response.create' })
      else {
        this.outputOpen = false
        await this.callbacks.end()
      }
    }
  }
  private addText(id: string, role: 'user' | 'assistant', delta: string, final: boolean) {
    const text = ((this.text.get(id) ?? '') + String(delta)).slice(0, 20_000)
    this.text.set(id, text)
    this.callbacks.transcript(id, role, text, final)
  }
  stop(error?: string) {
    if (!this.running) return
    this.running = false
    this.configured = false
    clearTimeout(this.timer)
    clearTimeout(this.idle)
    clearInterval(this.heartbeat)
    this.rejectStart?.(new Error(error ?? 'Voice connection cancelled.'))
    this.rejectStart = undefined
    this.socket?.terminate()
    this.socket = undefined
    this.callbacks.closed(error)
  }
}
