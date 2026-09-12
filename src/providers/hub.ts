import { join, isAbsolute } from 'node:path'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { Task, Project, Connection } from '../shared/contracts'
import type { TaskRun } from '../core/tasks'
import { Store } from '../core/store'
import { CONNECTIONS } from '../shared/defaults'
import { hash, invariant, safeError } from '../core/util'
import { CodexAdapter } from './codex'
import { reviewWithClaude } from './claude'
import { fingerprint, git, prepareWorktree, reviewPackage, runCheck } from './workspace'
import { GoogleConnection } from './google'
import { REALTIME_MODEL } from './realtime'

type Host = <T = any>(method: string, params: unknown) => Promise<T>
export class ProviderHub {
  connections = structuredClone(CONNECTIONS)
  codex: CodexAdapter
  google: GoogleConnection
  mcp?: Client
  private mcpIdentity?: string
  constructor(
    private config: { dataDir: string; appPath: string; packaged: boolean },
    private store: Store,
    private host: Host,
    private changed: () => void,
  ) {
    this.codex = new CodexAdapter(config.dataDir, () => {
      const connection = this.connections.find((c) => c.id === 'codex')!
      if (this.codex.account) {
        connection.status = 'connected'
        connection.detail = 'Official ChatGPT sign-in'
      }
      this.changed()
    })
    this.google = new GoogleConnection(host)
  }
  private status(id: string, status: Connection['status'], detail?: string) {
    const connection = this.connections.find((c) => c.id === id)
    invariant(connection, 'Unknown connection.')
    connection.status = status
    connection.detail = detail
    this.changed()
  }
  async restore() {
    const enabled = this.store.getSetting<string[]>('connections', [])
    for (const id of enabled) {
      if (id === 'claude' && (await this.host('credential.get', { account: 'claude-api' })))
        this.status(id, 'connected', 'API credential saved in Keychain')
      if (id === 'openai-realtime' && (await this.host('credential.get', { account: id })))
        this.status(id, 'connected', `${REALTIME_MODEL} · credential saved in Keychain`)
      if (id === 'google' && (await this.host('credential.get', { account: 'google-oauth' })))
        this.status(id, 'connected', 'Read-only OAuth scopes')
      if (id === 'codex') {
        try {
          await this.codex.start()
        } catch (error) {
          this.status(id, 'error', safeError(error))
        }
      }
      if (id.startsWith('apple-') || id === 'browser' || id === 'automation')
        this.status(id, 'disconnected', 'Reconnect to verify macOS permission')
    }
  }
  async connect(id: string, config: Record<string, string>) {
    invariant(
      this.store.settings().privacyMode !== 'local-only' ||
        id.startsWith('apple-') ||
        id === 'browser' || id === 'automation',
      'This connection is disabled in local-only mode.',
    )
    this.status(id, 'connecting')
    try {
      if (id === 'codex') {
        const login = await this.codex.login()
        invariant(login.authUrl, 'Codex did not return a sign-in URL.')
        await this.host('open.external', { url: login.authUrl })
        this.status(id, 'connecting', 'Finish the official Codex sign-in in your browser')
      } else if (id === 'claude') {
        invariant(config.apiKey?.startsWith('sk-ant-'), 'Enter an Anthropic API key.')
        const response = await fetch('https://api.anthropic.com/v1/models?limit=1', {
          headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(15_000),
        })
        invariant(response.ok, `Claude could not verify this credential (${response.status}).`)
        await this.host('credential.set', { account: 'claude-api', value: config.apiKey })
        this.status(id, 'connected', 'API access verified · Keychain protected')
      } else if (id === 'openai-realtime') {
        invariant(config.apiKey?.startsWith('sk-'), 'Enter an OpenAI API key.')
        // Asking for the model itself checks access to it, not merely that the key parses.
        const response = await fetch(`https://api.openai.com/v1/models/${REALTIME_MODEL}`, {
          headers: { authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(15_000),
        })
        invariant(
          response.ok,
          response.status === 404
            ? 'This key does not have access to the realtime model.'
            : `OpenAI could not verify this credential (${response.status}).`,
        )
        await this.host('credential.set', { account: 'openai-realtime', value: config.apiKey })
        this.status(id, 'connected', 'Speech to speech · your voice leaves this Mac')
      } else if (id === 'google') {
        await this.google.connect(config.clientId, config.clientSecret)
        this.status(id, 'connected', 'Gmail, Calendar, and Drive · read-only access')
      } else if (id === 'automation') {
        const permissions = await this.host('native', {
          method: 'permission.request',
          params: { permission: 'accessibility' },
        })
        invariant(
          permissions.accessibility,
          'Allow Accessibility for Jarvis in System Settings, then connect again.',
        )
        this.status(id, 'connected', 'Named controls · every press approved individually')
      } else if (id === 'apple-calendar' || id === 'apple-reminders') {
        const permissions = await this.host('native', {
          method: 'permission.request',
          params: { permission: id === 'apple-calendar' ? 'calendars' : 'reminders' },
        })
        const status = permissions[id === 'apple-calendar' ? 'calendars' : 'reminders']
        invariant(
          ['fullAccess', 'authorized'].includes(status),
          'Allow access in macOS System Settings first.',
        )
        this.status(id, 'connected', 'Native EventKit connection')
      } else if (id === 'apple-mail' || id === 'browser') {
        await this.host('native', {
          method: id === 'apple-mail' ? 'apple.mail.selected' : 'browser.tabs',
          params: {},
        })
        this.status(id, 'connected', 'Selected context through macOS Automation')
      } else if (id === 'mcp') {
        invariant(
          isAbsolute(config.command ?? '') && existsSync(config.command),
          'Choose an existing, absolute server executable.',
        )
        const args = JSON.parse(config.args || '[]')
        invariant(
          Array.isArray(args) && args.every((a) => typeof a === 'string') && args.length <= 30,
          'Server arguments must be a JSON array of strings.',
        )
        const home = join(this.config.dataDir, 'providers/mcp')
        mkdirSync(home, { recursive: true, mode: 0o700 })
        await this.mcp?.close()
        this.mcp = new Client({ name: 'jarvis', version: '0.1.0' })
        await this.mcp.connect(
          new StdioClientTransport({
            command: config.command,
            args,
            cwd: home,
            env: { HOME: home, PATH: '/usr/bin:/bin' },
            stderr: 'ignore',
          }),
        )
        await this.mcp.listTools()
        this.mcpIdentity = hash({ command: config.command, args })
        this.status(id, 'connected', 'Tools available to tasks · each call requires approval')
      }
      this.store.setSetting('connections', [
        ...new Set([...this.store.getSetting<string[]>('connections', []), id]),
      ])
      return true
    } catch (error) {
      this.status(id, 'error', safeError(error))
      throw error
    }
  }
  async disconnect(id: string) {
    invariant(
      !this.store
        .tasks()
        .some(
          (t) =>
            t.provider === id && ['running', 'verifying', 'awaiting_approval'].includes(t.state),
        ),
      'Pause the active task before disconnecting its provider.',
    )
    if (id === 'codex') await this.codex.logout()
    if (id === 'claude') await this.host('credential.delete', { account: 'claude-api' })
    if (id === 'openai-realtime') await this.host('credential.delete', { account: id })
    if (id === 'google') await this.host('credential.delete', { account: 'google-oauth' })
    if (id === 'mcp') {
      await this.mcp?.close()
      this.mcp = undefined
      this.mcpIdentity = undefined
    }
    this.store.setSetting(
      'connections',
      this.store.getSetting<string[]>('connections', []).filter((c) => c !== id),
    )
    this.status(id, 'disconnected')
    return true
  }
  async inspect(id: string) {
    invariant(
      this.connections.some(
        (connection) => connection.id === id && connection.status === 'connected',
      ),
      'Connect and verify this integration first.',
    )
    if (id === 'codex') return { account: (await this.codex.refresh())?.type ?? null, protocol: 1 }
    if (id === 'claude')
      return {
        credentialPresent: !!(await this.host('credential.get', { account: 'claude-api' })),
        reviewTools: [],
        usageCeiling: this.store.settings().budget.maxCostUsd,
      }
    if (id === 'openai-realtime') return {
      model: REALTIME_MODEL,
      credentialPresent: !!(await this.host('credential.get', { account: id })),
      transport: 'Native PCM over WebSocket',
      sessionVerified: false,
    }
    if (id === 'google') return this.google.inspect()
    if (id === 'mcp') {
      invariant(this.mcp, 'Connect a server first.')
      return this.mcp.listTools()
    }
    const methods: Record<string, string> = {
      automation: 'ui.applications',
      'apple-calendar': 'apple.events',
      'apple-reminders': 'apple.reminders',
      'apple-mail': 'apple.mail.selected',
      browser: 'browser.tabs',
    }
    invariant(methods[id], 'Unknown connection.')
    return this.host('native', { method: methods[id], params: {} })
  }
  async mcpTools() {
    if (this.store.settings().privacyMode === 'local-only') return []
    if (!this.mcp || !this.mcpIdentity) return []
    const result = await this.mcp.listTools()
    return result.tools.slice(0, 40)
  }
  async callMcp(name: string, args: Record<string, unknown>, run: TaskRun) {
    invariant(this.store.settings().privacyMode !== 'local-only', 'MCP tools are disabled in local-only mode.')
    const client = this.mcp
    const identity = this.mcpIdentity
    invariant(client && identity, 'Connect the reviewed MCP server first.')
    const tool = (await this.mcpTools()).find((tool) => tool.name === name)
    invariant(tool, 'That tool is not offered by the connected server.')
    const validation = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args)
    invariant(validation.valid, validation.errorMessage ?? 'Invalid tool arguments.')
    const targetHash = hash({ identity, tool })
    const approval = await run.authorize('mcp.call', { name, arguments: args, schema: tool.inputSchema },
      `Connected MCP server / ${name}`, targetHash, `Run ${name} with the reviewed arguments`)
    invariant(this.mcp === client && this.mcpIdentity === identity, 'The MCP connection changed after approval.')
    invariant(this.store.settings().privacyMode !== 'local-only', 'Local-only mode was enabled after this call was proposed.')
    const current = (await this.mcpTools()).find((item) => item.name === name)
    const result = await run.effect(approval, hash({ identity, tool: current }), () =>
      client.callTool({ name, arguments: args }, undefined, { signal: run.signal, timeout: 60_000 }))
    invariant(!result.isError, 'The MCP tool reported a failure. Its response is recorded in the task ledger.')
    return result
  }
  async execute(task: Task, project: Project | undefined, run: TaskRun) {
    invariant(
      project?.trusted,
      'Choose a repository and approve its scope before starting this task.',
    )
    const apiKey = await this.host<string | null>('credential.get', { account: 'claude-api' })
    invariant(task.budget.maxCostUsd, 'Configure a usage ceiling before starting.')
    if (task.provider === 'claude') {
      invariant(apiKey, 'Connect Claude before starting the independent review workflow.')
      run.stage('Preparing a fixed, read-only review package')
      const baseline = await git(project.path, ['rev-parse', 'HEAD'])
      const pkg = await reviewPackage(project.path, baseline)
      const review = await this.review(task, project.path, pkg, apiKey, run)
      invariant(
        (await fingerprint(project.path)) === pkg.revision,
        'The repository changed during review. Re-run against the new revision.',
      )
      run.evidence({
        kind: 'review',
        label: 'Claude review of the recorded revision',
        value: review.text,
        hash: pkg.revision,
        verified: true,
      })
      return {
        summary: 'Independent review is ready.',
        limitations: ['Review findings are advisory. No repository files were changed by Claude.'],
      }
    }
    run.stage('Resolving the repository and baseline')
    const baseline = task.baselineHash ?? (await git(project.path, ['rev-parse', 'HEAD']))
    const worktree = task.worktree ?? join(this.config.dataDir, 'worktrees', task.id)
    if (!task.worktree) {
      const repositoryState = await fingerprint(project.path)
      const approval = await run.authorize(
        'worktree.implement',
        {
          repository: project.path,
          baseline,
          destination: worktree,
          objective: task.objective,
          checks: project.checks,
          networkAccess: false,
          originalCheckout: 'Preserved. Uncommitted changes are not copied.',
          reviewDestination: apiKey
            ? 'Anthropic API'
            : 'No independent review; Claude is not connected',
          maximumReviewCostUsd: apiKey ? task.budget.maxCostUsd : 0,
        },
        worktree,
        repositoryState,
        'Let Codex implement in a new isolated worktree',
      )
      await run.effect(approval, await fingerprint(project.path), async () => {
        await prepareWorktree(project.path, worktree, baseline, run.signal)
        const current = this.store.getTask(task.id)
        this.store.updateTask(
          task.id,
          current.revision,
          (t) => ({ ...t, worktree, baselineHash: baseline }),
          { type: 'worktree.created', message: 'The original checkout is preserved' },
        )
        return worktree
      })
    }
    run.stage('Codex is implementing in the isolated worktree')
    const implementationState = await fingerprint(worktree)
    const implementationApproval = await run.authorize(
      'codex.implement',
      {
        objective: task.objective,
        cwd: worktree,
        baseline,
        networkAccess: false,
        provider: 'Codex / ChatGPT',
        reviewDestination: apiKey
          ? 'Anthropic API'
          : 'No independent review; Claude is not connected',
        maximumReviewCostUsd: apiKey ? task.budget.maxCostUsd : 0,
      },
      worktree,
      implementationState,
      'Implement this task revision with Codex',
    )
    const implementation = await run.effect(
      implementationApproval,
      await fingerprint(worktree),
      () =>
        this.codex.run({
          cwd: worktree,
          instruction: task.objective,
          threadId: task.providerIds.codex,
          run,
        }),
      () => reviewPackage(worktree, baseline),
    )
    run.stage('Freezing the change package for Claude')
    const pkg = await reviewPackage(worktree, baseline)
    run.evidence({
      kind: 'diff',
      label: 'Recorded change package',
      value: pkg.diff + pkg.untracked.map((f) => `\nNew file: ${f.path}\n${f.content}`).join(''),
      hash: pkg.revision,
      verified: true,
    })
    // Without a reviewer the work still runs, and the receipt says plainly that none was asked.
    if (apiKey) {
      run.stage('Claude is reviewing the fixed revision')
      const review = await this.review(task, worktree, pkg, apiKey, run)
      invariant(
        (await fingerprint(worktree)) === pkg.revision,
        'The worktree changed during review. Review evidence is no longer current.',
      )
      run.evidence({
        kind: 'review',
        label: 'Independent Claude review',
        value: review.text,
        hash: pkg.revision,
        verified: true,
      })
    }
    invariant(
      project.checks.length > 0,
      'Configure a verification command for this repository. Completion requires a scoped check.',
    )
    for (const check of project.checks) {
      run.stage(`Checking: ${check}`)
      const approval = await run.authorize(
        'check.run',
        {
          command: check,
          cwd: worktree,
          revision: pkg.revision,
          networkAccess: false,
          timeoutSeconds: 180,
        },
        worktree,
        pkg.revision,
        `Run ${check} against this revision`,
      )
      const result = await run.effect(approval, await fingerprint(worktree), () =>
        runCheck(worktree, check, join(this.config.dataDir, 'checks', task.id), run.signal),
      )
      invariant(
        (await fingerprint(worktree)) === pkg.revision,
        'A check changed the reviewed files. The review and test evidence must be refreshed.',
      )
      run.evidence({
        kind: 'check',
        label: check,
        value: result.output,
        hash: pkg.revision,
        exitCode: result.exitCode,
        verified: result.exitCode === 0,
      })
      invariant(result.exitCode === 0, `The check failed: ${check}.`)
    }
    return {
      summary: 'Implementation, independent review, and configured checks are ready.',
      limitations: [
        'Changes remain in the isolated worktree. Nothing was committed, merged, or published.',
        apiKey
          ? 'Claude findings require your review; passing checks do not prove all behavior.'
          : 'No independent review was performed: Claude is not connected. Only the configured checks were run.',
        'Codex uses your ChatGPT plan. Its usage is not represented as an API dollar cost.',
        implementation,
      ].filter(Boolean),
    }
  }
  private async review(
    task: Task,
    path: string,
    pkg: Awaited<ReturnType<typeof reviewPackage>>,
    apiKey: string,
    run: TaskRun,
  ) {
    const ceiling = this.store.settings().budget.maxCostUsd
    invariant(
      ceiling !== null && this.store.settings().privacyMode !== 'local-only',
      'Enable the cloud connection and configure a usage ceiling before sending this review.',
    )
    const budget =
      Math.min(task.budget.maxCostUsd!, ceiling!) - (this.store.getTask(task.id).costUsd ?? 0)
    invariant(budget > 0, 'This task has used its review budget. No further paid calls were made.')
    const approval = await run.authorize(
      'claude.review',
      { objective: task.objective, package: pkg, packageHash: hash(pkg), maximumCostUsd: budget },
      'Anthropic API',
      pkg.revision,
      'Send this exact change package to Claude for review',
    )
    const currentCeiling = this.store.settings().budget.maxCostUsd
    invariant(
      currentCeiling !== null &&
        currentCeiling >= budget + (this.store.getTask(task.id).costUsd ?? 0) &&
        this.store.settings().privacyMode !== 'local-only',
      'The usage ceiling or cloud setting changed. Request a fresh review approval.',
    )
    return run.effect(approval, await fingerprint(path), () =>
      reviewWithClaude({
        package: pkg,
        objective: task.objective,
        apiKey,
        dataDir: this.config.dataDir,
        run,
        budget,
      }),
    )
  }
  stop() {
    this.codex.stop()
    void this.mcp?.close()
  }
}
