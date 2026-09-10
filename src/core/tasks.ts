import {
  Task,
  type TaskState,
  type Approval,
  type Evidence,
  type Project,
  type Provider,
  type Budget,
  type ToolProposal,
} from '../shared/contracts'
import { Store } from './store'
import { hash, invariant, now, safeError, uid } from './util'

const terminal = new Set<TaskState>(['completed', 'failed', 'cancelled'])
export interface TaskRun {
  signal: AbortSignal
  stage(message: string): void
  checkpoint(): Task
  evidence(value: Omit<Evidence, 'id' | 'revision'>): void
  session(provider: string, id: string): void
  succeeded(tool: string): { proposal: ToolProposal; result: unknown }[]
  usage(costUsd: number): void
  authorize(
    tool: string,
    args: Record<string, unknown>,
    target: string,
    targetHash: string,
    description: string,
  ): Promise<Approval>
  effect<T>(
    approval: Approval,
    targetHash: string,
    perform: () => Promise<T>,
    inspectFailure?: () => Promise<unknown>,
  ): Promise<T>
}
export type TaskExecutor = (
  task: Task,
  project: Project | undefined,
  run: TaskRun,
) => Promise<{ summary: string; limitations: string[] }>

/** The ledger is authoritative; adapters can report progress, never completion. */
export class TaskEngine {
  private closing = false
  private suspended = false
  private running = new Map<
    string,
    { controller: AbortController; revision: number; stopping?: 'paused' | 'cancelled' }
  >()
  private decisions = new Map<
    string,
    { resolve: (value: Approval) => void; reject: (error: Error) => void }
  >()
  constructor(
    readonly store: Store,
    private execute: TaskExecutor,
    private changed: () => void,
  ) {}
  get activeCount() {
    return this.running.size
  }

  recover() {
    for (const task of this.store.tasks(10_000)) {
      if (terminal.has(task.state) || task.state === 'paused' || task.state === 'draft') continue
      this.store.revokeApprovals(task.id)
      const uncertain = this.store.uncertainEffects(task.id).length > 0
      this.store.updateTask(
        task.id,
        task.revision,
        (t) => ({
          ...t,
          state: uncertain ? 'needs_reconciliation' : 'paused',
          stage: uncertain
            ? 'An interrupted effect needs inspection'
            : 'Ready to resume after restart',
        }),
        {
          type: 'recovery',
          message: 'Execution stopped at the previous process boundary. No effects were retried.',
        },
      )
    }
  }
  create(objective: string, provider: Provider, project: Project | undefined, budget: Budget) {
    invariant(
      !this.closing && !this.suspended,
      'Task execution is paused while Jarvis is closing or your Mac is locked.',
    )
    if (provider !== 'local') {
      const ceiling = this.store.settings().budget.maxCostUsd
      invariant(
        budget.maxCostUsd !== null && ceiling !== null,
        'Set a usage ceiling in Settings before starting a cloud task.',
      )
      budget = { ...budget, maxCostUsd: Math.min(budget.maxCostUsd!, ceiling!) }
      invariant(
        this.store.settings().privacyMode !== 'local-only',
        'Cloud connections are disabled in local-only mode.',
      )
      invariant(project?.trusted, 'Choose a repository and approve its scope in Settings first.')
    }
    const task = Task.parse({
      id: uid(),
      revision: 1,
      objective,
      provider,
      state: 'queued',
      scope: project?.id ?? 'personal',
      stage: 'Queued',
      createdAt: now(),
      updatedAt: now(),
      budget,
    })
    this.store.insertTask(task)
    this.store.appendEvent(task.id, 1, { type: 'created', message: objective })
    this.changed()
    this.pump()
    return task
  }
  private pump() {
    if (this.closing || this.suspended || this.running.size) return
    const next = this.store
      .tasks(10_000)
      .reverse()
      .find((t) => t.state === 'queued')
    if (next) void this.start(next)
  }
  private async start(task: Task) {
    const controller = new AbortController()
    const active = { controller, revision: task.revision } as {
      controller: AbortController
      revision: number
      stopping?: 'paused' | 'cancelled'
    }
    this.running.set(task.id, active)
    const timer = setTimeout(
      () => controller.abort(new Error('The task reached its time budget.')),
      task.budget.timeoutMs,
    )
    const checkpoint = () => {
      controller.signal.throwIfAborted()
      const current = this.store.getTask(task.id)
      invariant(current.revision === task.revision, 'A newer instruction replaced this revision.')
      invariant(current.steps < current.budget.maxSteps, 'The task reached its step budget.')
      return current
    }
    const update = (change: (t: Task) => Task, type: string, message: string) => {
      checkpoint()
      this.store.updateTask(task.id, task.revision, change, { type, message })
      this.changed()
    }
    const run: TaskRun = {
      signal: controller.signal,
      checkpoint,
      succeeded: (tool) =>
        this.store
          .effects(task.id)
          .filter(
            (effect) =>
              effect.state === 'succeeded' &&
              effect.payload.proposal?.revision === task.revision &&
              effect.payload.proposal.tool === tool,
          )
          .map((effect) => effect.payload),
      usage: (costUsd) => {
        invariant(Number.isFinite(costUsd) && costUsd >= 0, 'Invalid provider usage.')
        // Charge completed provider usage even if a newer instruction arrived meanwhile.
        const current = this.store.getTask(task.id)
        this.store.updateTask(
          task.id,
          current.revision,
          (t) => ({ ...t, costUsd: (t.costUsd ?? 0) + costUsd }),
          {
            type: 'usage',
            message: 'Provider usage recorded',
            data: { costUsd, originalRevision: task.revision },
          },
        )
        this.changed()
      },
      stage: (message) =>
        update((t) => ({ ...t, stage: message, steps: t.steps + 1 }), 'stage', message),
      evidence: (value) =>
        update(
          (t) => ({
            ...t,
            evidence: [...t.evidence, { ...value, id: uid(), revision: task.revision }],
          }),
          'evidence',
          value.label,
        ),
      session: (provider, id) =>
        update(
          (t) => ({ ...t, providerIds: { ...t.providerIds, [provider]: id } }),
          'session',
          `${provider} session recorded`,
        ),
      authorize: async (tool, args, target, targetHash, description) => {
        checkpoint()
        const proposal = {
          id: uid(),
          taskId: task.id,
          revision: task.revision,
          tool,
          toolVersion: 1 as const,
          arguments: args,
          target,
          targetHash,
          argumentHash: '',
          risk: 'P2' as const,
          description,
        }
        proposal.argumentHash = hash({ ...proposal, argumentHash: undefined })
        const approval: Approval = {
          id: uid(),
          proposal,
          policyVersion: 1,
          createdAt: now(),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          decision: 'pending',
        }
        this.store.saveApproval(approval)
        update(
          (t) => ({ ...t, state: 'awaiting_approval', stage: description }),
          'approval.requested',
          description,
        )
        const decision = await new Promise<Approval>((resolve, reject) => {
          const abort = () => {
            this.decisions.delete(approval.id)
            reject(new Error('Approval cancelled.'))
          }
          controller.signal.addEventListener('abort', abort, { once: true })
          this.decisions.set(approval.id, {
            resolve: (value) => {
              controller.signal.removeEventListener('abort', abort)
              resolve(value)
            },
            reject: (error) => {
              controller.signal.removeEventListener('abort', abort)
              reject(error)
            },
          })
        })
        checkpoint()
        update((t) => ({ ...t, state: 'running' }), 'approval.approved', description)
        return decision
      },
      effect: async (approval, targetHash, perform, inspectFailure) => {
        checkpoint()
        const persisted = this.store.approval(approval.id)
        invariant(
          persisted?.decision === 'approved' && persisted.proposal.revision === task.revision,
          'This effect does not have a current approval.',
        )
        invariant(
          persisted.proposal.targetHash === targetHash && persisted.expiresAt > now(),
          'The target changed or the approval expired. Review the action again.',
        )
        invariant(
          hash({ ...persisted.proposal, argumentHash: undefined }) ===
            persisted.proposal.argumentHash,
          'Approval arguments changed.',
        )
        const effectId = this.store.intent(
          task.id,
          approval.id,
          `${task.id}:${task.revision}:${approval.id}`,
          persisted.proposal,
        )
        let result
        try {
          result = await perform()
        } catch (error) {
          if (inspectFailure) {
            let observed: unknown
            let inspected = false
            try {
              observed = await inspectFailure()
              inspected = true
            } catch {
              /* Retain an uncertain outcome below. */
            }
            if (inspected) {
              this.store.finishEffect(effectId, 'failed', {
                proposal: persisted.proposal,
                observed,
                error: safeError(error),
              })
              const current = this.store.getTask(task.id)
              this.store.updateTask(
                task.id,
                current.revision,
                (t) => ({
                  ...t,
                  completedEffects: [
                    ...t.completedEffects,
                    `Interrupted action inspected: ${persisted.proposal.description}`,
                  ],
                }),
                {
                  type: 'effect.inspected',
                  message: 'Partial effects were inspected after the executor stopped',
                  data: { effectId, originalRevision: task.revision },
                },
              )
              throw error
            }
          }
          this.store.finishEffect(effectId, 'uncertain', {
            proposal: persisted.proposal,
            error: safeError(error),
          })
          throw error
        }
        this.store.finishEffect(effectId, 'succeeded', { proposal: persisted.proposal, result })
        // A successful dispatch stays recorded if cancellation or steering arrived meanwhile.
        const current = this.store.getTask(task.id)
        this.store.updateTask(
          task.id,
          current.revision,
          (t) => ({
            ...t,
            completedEffects: [...t.completedEffects, persisted.proposal.description],
          }),
          {
            type: 'effect.succeeded',
            message: persisted.proposal.description,
            data: { originalRevision: task.revision },
          },
        )
        this.changed()
        checkpoint()
        return result
      },
    }
    try {
      update(
        (t) => ({ ...t, state: 'running', error: undefined, stage: 'Preparing' }),
        'started',
        'Execution started',
      )
      const result = await this.execute(
        this.store.getTask(task.id),
        this.store.projects().find((p) => p.id === task.scope),
        run,
      )
      update(
        (t) => ({ ...t, state: 'verifying', stage: 'Verifying observed results' }),
        'verification.started',
        'Provider completion received; checking evidence',
      )
      const current = checkpoint()
      invariant(
        !this.store.uncertainEffects(task.id).length,
        'An effect still needs reconciliation.',
      )
      invariant(
        current.evidence.length > 0 &&
          current.evidence.every((e) => e.verified && e.revision === current.revision),
        'Completion requires verified evidence for this revision.',
      )
      update(
        (t) => ({ ...t, state: 'completed', stage: result.summary }),
        'completed',
        result.summary,
      )
      this.receipt(task.id, result.summary, result.limitations)
    } catch (error) {
      const current = this.store.getTask(task.id)
      if (current.revision === task.revision) {
        const state = this.store.uncertainEffects(task.id).length
          ? 'needs_reconciliation'
          : (active.stopping ?? 'failed')
        this.store.updateTask(
          task.id,
          task.revision,
          (t) => ({
            ...t,
            state,
            error: active.stopping ? undefined : safeError(error),
            stage:
              state === 'paused'
                ? 'Paused. Your work is preserved.'
                : state === 'cancelled'
                  ? 'Cancelled. Completed effects are retained.'
                  : safeError(error),
          }),
          { type: state, message: safeError(error) },
        )
        if (state === 'failed' || state === 'cancelled')
          this.receipt(task.id, this.store.getTask(task.id).stage, [
            'Work may be incomplete. Inspect retained effects and evidence.',
          ])
      }
    } finally {
      clearTimeout(timer)
      this.store.revokeApprovals(task.id)
      this.running.delete(task.id)
      const current = this.store.getTask(task.id)
      if (current.revision !== task.revision && this.store.uncertainEffects(task.id).length) {
        this.store.updateTask(
          task.id,
          current.revision,
          (t) => ({
            ...t,
            state: 'needs_reconciliation',
            stage: 'Inspect the previous revision’s interrupted effect before continuing.',
          }),
          {
            type: 'reconciliation.required',
            message:
              'Steering is saved; execution is held until the previous effect is reconciled.',
          },
        )
      }
      this.changed()
      this.pump()
    }
  }
  decide(id: string, decision: 'approved' | 'denied', argumentHash: string) {
    const approval = this.store.approval(id)
    invariant(approval?.decision === 'pending', 'This approval is no longer pending.')
    const task = this.store.getTask(approval.proposal.taskId)
    invariant(
      task.revision === approval.proposal.revision &&
        approval.expiresAt > now() &&
        argumentHash === approval.proposal.argumentHash,
      'This approval is stale. Request a new proposal.',
    )
    const waiter = this.decisions.get(id)
    invariant(
      waiter,
      'This execution is no longer active. Resume the task to request a fresh approval.',
    )
    this.store.saveApproval({ ...approval, decision })
    this.decisions.delete(id)
    if (decision === 'approved') waiter.resolve({ ...approval, decision })
    else waiter.reject(new Error('You declined this action.'))
    this.changed()
  }
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'reconcile') {
    const task = this.store.getTask(id)
    invariant(!terminal.has(task.state), 'This task has already ended.')
    if (action === 'reconcile') {
      invariant(task.state === 'needs_reconciliation', 'This task does not need reconciliation.')
      return this.store.effects(id)
    }
    if (action === 'resume') {
      invariant(!this.closing && !this.suspended, 'Unlock your Mac before resuming.')
      invariant(task.state === 'paused', 'Only a paused task can resume.')
      invariant(!this.running.has(id), 'The previous execution is still stopping.')
      this.store.updateTask(
        id,
        task.revision,
        (t) => ({ ...t, state: 'queued', stage: 'Queued to resume' }),
        { type: 'resumed', message: 'Resuming preserved provider context' },
      )
      this.changed()
      this.pump()
      return
    }
    const active = this.running.get(id)
    if (active && active.revision === task.revision) {
      active.stopping = action === 'pause' ? 'paused' : 'cancelled'
      this.store.updateTask(
        id,
        task.revision,
        (t) => ({
          ...t,
          state: action === 'pause' ? 'pausing' : 'cancel_requested',
          stage: action === 'pause' ? 'Pausing execution' : 'Stopping execution',
        }),
        { type: 'control.requested', message: action },
      )
      active.controller.abort(
        new Error(action === 'pause' ? 'Paused by you.' : 'Cancelled by you.'),
      )
    } else {
      this.store.updateTask(
        id,
        task.revision,
        (t) => ({
          ...t,
          state: action === 'pause' ? 'paused' : 'cancelled',
          stage: action === 'pause' ? 'Paused' : 'Cancelled',
        }),
        { type: action, message: action },
      )
      if (action === 'cancel')
        this.receipt(
          id,
          'Closed without retrying any action.',
          this.store.uncertainEffects(id).length
            ? [
                'Some external outcomes remain uncertain. Inspect the exported effect ledger before creating any replacement task.',
              ]
            : ['Any previously completed effects remain in place.'],
        )
    }
    this.store.revokeApprovals(id)
    this.changed()
  }
  steer(id: string, revision: number, text: string) {
    const task = this.store.getTask(id)
    invariant(
      task.revision === revision &&
        !terminal.has(task.state) &&
        task.state !== 'needs_reconciliation',
      'This task cannot accept steering at this revision.',
    )
    invariant(
      this.store.uncertainEffects(id).every((effect) => effect.state === 'intent') &&
        (this.running.has(id) || !this.store.uncertainEffects(id).length),
      'Reconcile the previous uncertain effect before steering.',
    )
    this.running.get(id)?.controller.abort(new Error('Steered to a new revision.'))
    this.store.revokeApprovals(id)
    this.store.updateTask(
      id,
      revision,
      (t) => ({
        ...t,
        revision: revision + 1,
        objective: `${t.objective}\n\nUpdated instruction: ${text}`,
        state: 'queued',
        stage: 'Preparing your updated instruction',
        evidence: [],
        error: undefined,
      }),
      { type: 'steered', message: text },
    )
    this.changed()
    this.pump()
  }
  private receipt(id: string, summary: string, limitations: string[]) {
    const task = this.store.getTask(id)
    this.store.saveReceipt({
      id: uid(),
      taskId: id,
      revision: task.revision,
      status: task.state,
      objective: task.objective,
      provider: task.provider,
      createdAt: now(),
      evidence: task.evidence,
      effects: task.completedEffects,
      limitations,
      summary,
      costUsd: task.costUsd,
    })
  }
  suspend(value: boolean) {
    this.suspended = value
    if (value) {
      for (const task of this.store.tasks(10_000)) {
        if (['queued', 'running', 'verifying', 'awaiting_approval'].includes(task.state))
          this.control(task.id, 'pause')
      }
    }
  }
  async shutdown() {
    this.closing = true
    for (const active of this.running.values()) {
      active.stopping = 'paused'
      active.controller.abort(new Error('Jarvis is closing.'))
    }
    while (this.running.size) await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
