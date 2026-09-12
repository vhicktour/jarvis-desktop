import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderHub } from '../src/providers/hub'
import type { Store } from '../src/core/store'
import type { TaskRun } from '../src/core/tasks'

test('MCP validates arguments and binds the approved server and schema before dispatch', async () => {
  let mode = 'local-first'
  const store = { settings: () => ({ privacyMode: mode }) } as unknown as Store
  const hub = new ProviderHub(
    { dataDir: '/tmp/jarvis-mcp-fixture', appPath: '.', packaged: false },
    store,
    async () => undefined as any,
    () => {},
  )
  let calls = 0
  let schema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  }
  const client = {
    listTools: async () => ({ tools: [{ name: 'search', inputSchema: schema }] }),
    callTool: async () => {
      calls++
      return { content: [{ type: 'text', text: 'Observed result' }] }
    },
  }
  Object.assign(hub, { mcp: client, mcpIdentity: 'fixture-server' })
  let approve: () => void = () => {}
  const run = {
    signal: new AbortController().signal,
    authorize: async (_tool: string, args: any, _target: string, targetHash: string) => {
      approve()
      return { proposal: { targetHash, arguments: args } }
    },
    effect: async (approval: any, currentHash: string, perform: () => Promise<any>) => {
      assert.equal(currentHash, approval.proposal.targetHash, 'Approval target changed')
      return perform()
    },
  } as unknown as TaskRun
  await assert.rejects(hub.callMcp('search', { query: 12 }, run))
  assert.equal(calls, 0)
  await hub.callMcp('search', { query: 'build' }, run)
  assert.equal(calls, 1)
  approve = () => {
    schema = { ...schema, required: [] }
  }
  await assert.rejects(hub.callMcp('search', { query: 'changed schema' }, run), /target changed/)
  assert.equal(calls, 1)
  approve = () => {
    mode = 'local-only'
  }
  await assert.rejects(hub.callMcp('search', { query: 'changed privacy' }, run), /Local-only/)
  assert.equal(calls, 1)
  assert.deepEqual(await hub.mcpTools(), [])
})
