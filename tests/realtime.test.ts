import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import {
  RealtimeVoice,
  REALTIME_MODEL,
  realtimeCost,
  type RealtimeCallbacks,
} from '../src/providers/realtime'

async function until(predicate: () => boolean) {
  const end = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < end, 'Expected voice event did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
async function fixture(overrides: Partial<RealtimeCallbacks> = {}, budget = 2) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const sent: any[] = []
  const heard = {
    begin: 0,
    end: 0,
    interruptions: 0,
    audio: [] as Buffer[],
    phases: [] as string[],
    transcripts: [] as unknown[],
    closed: [] as (string | undefined)[],
    usage: [] as number[],
  }
  let peer: WebSocket
  server.on('connection', (socket) => {
    peer = socket
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString())
      sent.push(event)
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
    })
  })
  const voice = new RealtimeVoice(
    {
      begin: async () => {
        heard.begin++
      },
      end: async () => {
        heard.end++
      },
      audio: async (pcm) => {
        heard.audio.push(Buffer.from(pcm, 'base64'))
      },
      interrupt: async () => {
        heard.interruptions++
        return 250
      },
      phase: (phase) => {
        heard.phases.push(phase)
      },
      transcript: (...args) => {
        heard.transcripts.push(args)
      },
      tool: async () => ({ queued: true }),
      closed: (error) => {
        heard.closed.push(error)
      },
      usage: (cost) => {
        heard.usage.push(cost)
      },
      ...overrides,
    },
    () => new WebSocket(`ws://127.0.0.1:${address.port}`),
  )
  await voice.start('fixture-credential', {
    instructions: 'Be brief.',
    maxCostUsd: budget,
    maxSessionMs: 60_000,
    maxTokens: 512,
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Good evening.' },
    ],
  })
  return {
    voice,
    heard,
    sent,
    emit: (event: unknown) => peer.send(JSON.stringify(event)),
    close: async () => {
      voice.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test('manual endpointing can finish an active speech turn and rejects an empty or already committed turn', async () => {
  const f = await fixture()
  try {
    assert.equal(f.voice.commit(), false)
    f.emit({ type: 'input_audio_buffer.speech_started' })
    await until(() => f.heard.interruptions === 1)
    f.voice.append(Buffer.alloc(6000).toString('base64'))
    assert.equal(f.voice.commit(), true)
    assert.equal(f.voice.commit(), false)
    await until(() => f.sent.some((event) => event.type === 'input_audio_buffer.commit'))
    assert.equal(f.sent.filter((event) => event.type === 'response.create').length, 1)
  } finally {
    await f.close()
  }
})

test('realtime configures GA audio and tools, bounds input and delivers PCM in native-sized chunks', async () => {
  const f = await fixture()
  try {
    const session = f.sent[0].session
    assert.equal(session.model, REALTIME_MODEL)
    assert.deepEqual(session.audio.input.turn_detection, {
      type: 'semantic_vad',
      eagerness: 'high',
      create_response: true,
      interrupt_response: true,
    })
    assert.equal(session.audio.input.format.rate, 24000)
    assert.deepEqual(
      session.tools.map((tool: any) => tool.name),
      ['run_task', 'task_status', 'recall'],
    )
    assert.ok(!JSON.stringify(session).includes('fixture-credential'))
    await until(
      () => f.sent.filter((event) => event.type === 'conversation.item.create').length === 2,
    )
    assert.deepEqual(
      f.sent
        .filter((event) => event.type === 'conversation.item.create')
        .map((event) => event.item),
      [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Good evening.' }],
        },
      ],
    )
    f.voice.append(Buffer.alloc(5120).toString('base64'))
    f.voice.append(Buffer.alloc(50000).toString('base64'))
    f.voice.append(Buffer.alloc(3).toString('base64'))
    await until(() => f.sent.some((e) => e.type === 'input_audio_buffer.append'))
    assert.equal(f.sent.filter((e) => e.type === 'input_audio_buffer.append').length, 1)
    f.emit({ type: 'response.created', response: { id: 'r1' } })
    f.emit({
      type: 'response.output_audio.delta',
      response_id: 'r1',
      item_id: 'i1',
      content_index: 0,
      delta: Buffer.alloc(96000).toString('base64'),
    })
    await until(() => f.heard.audio.length === 2)
    assert.equal(f.heard.end, 0, 'A gap in incoming audio must not finish playback')
    f.emit({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } })
    await until(() => f.heard.end === 1)
    assert.deepEqual(
      f.heard.audio.map((a) => a.length),
      [48000, 48000],
    )
  } finally {
    await f.close()
  }
})

test('realtime interruption preempts blocked playback, truncates at heard audio and rejects late chunks', async () => {
  let release!: () => void
  let queued = 0
  let stopped = 0
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture({
    audio: async () => {
      queued++
      await barrier
    },
    interrupt: async () => {
      stopped++
      return 250
    },
  })
  try {
    f.emit({ type: 'response.created', response: { id: 'r1' } })
    const chunk = {
      type: 'response.output_audio.delta',
      response_id: 'r1',
      item_id: 'i1',
      content_index: 0,
      delta: Buffer.alloc(48000).toString('base64'),
    }
    f.emit(chunk)
    await until(() => queued === 1)
    f.emit(chunk)
    f.emit({ type: 'input_audio_buffer.speech_started' })
    await until(() => stopped === 1)
    assert.equal(queued, 1, 'Interruption must not wait for the playback callback')
    await until(() => f.sent.some((e) => e.type === 'conversation.item.truncate'))
    assert.equal(f.sent.find((e) => e.type === 'conversation.item.truncate').audio_end_ms, 250)
    assert.equal(f.sent.find((e) => e.type === 'response.cancel').response_id, 'r1')
    release()
    f.emit(chunk)
    f.emit({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } })
    await until(() => f.heard.usage.length === 1)
    assert.equal(queued, 1)
    assert.equal(f.heard.end, 0)
  } finally {
    release()
    await f.close()
  }
})

test('tool continuation keeps one audio stream and dispatches each call once', async () => {
  let calls = 0
  const f = await fixture({
    tool: async (name, args) => {
      calls++
      assert.equal(name, 'run_task')
      assert.deepEqual(args, { objective: 'Inspect the project' })
      return { taskId: 'task-1', completed: false }
    },
  })
  try {
    f.emit({ type: 'response.created', response: { id: 'r1' } })
    const done = {
      type: 'response.done',
      response: {
        id: 'r1',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'run_task',
            arguments: '{"objective":"Inspect the project"}',
          },
        ],
      },
    }
    f.emit(done)
    f.emit(done)
    await until(() => f.sent.some((e) => e.type === 'response.create'))
    assert.equal(calls, 1)
    assert.equal(f.heard.end, 0)
    f.emit({ type: 'response.created', response: { id: 'r2' } })
    f.emit({ type: 'response.done', response: { id: 'r2', status: 'completed', output: [] } })
    await until(() => f.heard.end === 1)
    assert.equal(f.heard.begin, 1)
    assert.equal(f.sent.filter((e) => e.type === 'response.create').length, 1)
  } finally {
    await f.close()
  }
})

test('audio offsets stay correct across tool preamble and answer items', async () => {
  const f = await fixture({ interrupt: async () => 1250 })
  try {
    f.emit({ type: 'response.created', response: { id: 'r1' } })
    for (const id of ['preamble', 'answer'])
      f.emit({
        type: 'response.output_audio.delta',
        response_id: 'r1',
        item_id: id,
        content_index: 0,
        delta: Buffer.alloc(48000).toString('base64'),
      })
    await until(() => f.heard.audio.length === 2)
    f.emit({ type: 'input_audio_buffer.speech_started' })
    await until(() => f.sent.some((e) => e.type === 'conversation.item.truncate'))
    const truncations = f.sent.filter((e) => e.type === 'conversation.item.truncate')
    assert.equal(truncations.length, 1)
    assert.equal(truncations[0].item_id, 'answer')
    assert.equal(truncations[0].audio_end_ms, 250)
  } finally {
    await f.close()
  }
})

test('reported spend closes the realtime session and prevents further input', async () => {
  const usage = {
    input_token_details: { text_tokens: 100, audio_tokens: 1000, cached_tokens: 0 },
    output_token_details: { text_tokens: 10, audio_tokens: 1000 },
  }
  assert.equal(realtimeCost(usage), 0.09664)
  const f = await fixture({}, 0.05)
  try {
    f.emit({
      type: 'response.done',
      response: { id: 'r1', status: 'completed', usage, output: [] },
    })
    await until(() => f.heard.closed.length === 1)
    assert.match(f.heard.closed[0]!, /usage ceiling/)
    const before = f.sent.length
    f.voice.append(Buffer.alloc(5120).toString('base64'))
    f.voice.commit()
    assert.equal(f.sent.length, before)
  } finally {
    await f.close()
  }
})
