import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const
export const MAX_MESSAGE_BYTES = 1024 * 1024

export const TaskState = z.enum([
  'draft',
  'needs_clarification',
  'awaiting_approval',
  'queued',
  'running',
  'pausing',
  'paused',
  'verifying',
  'completed',
  'failed',
  'cancel_requested',
  'cancelled',
  'needs_reconciliation',
])
export type TaskState = z.infer<typeof TaskState>
export const Provider = z.enum(['local', 'codex', 'claude'])
export type Provider = z.infer<typeof Provider>
export const Scope = z.string().min(1).max(500)
export const Budget = z.object({
  maxSteps: z.number().int().min(1).max(200).default(30),
  timeoutMs: z.number().int().min(10_000).max(7_200_000).default(1_200_000),
  maxCostUsd: z.number().positive().max(1000).nullable().default(null),
})
export type Budget = z.infer<typeof Budget>

export const Evidence = z.object({
  id: z.string(),
  kind: z.enum(['file', 'diff', 'check', 'review', 'observation', 'result']),
  label: z.string(),
  value: z.string(),
  hash: z.string().optional(),
  revision: z.number().int(),
  verified: z.boolean(),
  exitCode: z.number().nullable().optional(),
})
export type Evidence = z.infer<typeof Evidence>
export const Task = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  objective: z.string().min(1),
  state: TaskState,
  provider: Provider,
  stage: z.string(),
  scope: Scope,
  createdAt: z.string(),
  updatedAt: z.string(),
  budget: Budget,
  providerIds: z.record(z.string(), z.string()).default({}),
  evidence: z.array(Evidence).default([]),
  completedEffects: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  error: z.string().optional(),
  worktree: z.string().optional(),
  baselineHash: z.string().optional(),
  steps: z.number().int().default(0),
  costUsd: z.number().nullable().default(null),
})
export type Task = z.infer<typeof Task>
export const TaskEvent = z.object({
  id: z.string(),
  taskId: z.string(),
  revision: z.number().int(),
  sequence: z.number().int(),
  type: z.string(),
  timestamp: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
})
export type TaskEvent = z.infer<typeof TaskEvent>
export const ToolProposal = z.object({
  id: z.string(),
  taskId: z.string(),
  revision: z.number().int(),
  tool: z.string(),
  toolVersion: z.literal(1),
  arguments: z.record(z.string(), z.unknown()),
  target: z.string(),
  targetHash: z.string(),
  argumentHash: z.string(),
  risk: z.enum(['P0', 'P1', 'P2', 'P3']),
  description: z.string(),
})
export type ToolProposal = z.infer<typeof ToolProposal>
export const Approval = z.object({
  id: z.string(),
  proposal: ToolProposal,
  policyVersion: z.literal(1),
  createdAt: z.string(),
  expiresAt: z.string(),
  decision: z.enum(['pending', 'approved', 'denied', 'expired']),
})
export type Approval = z.infer<typeof Approval>
export const ActionReceipt = z.object({
  id: z.string(),
  taskId: z.string(),
  revision: z.number().int(),
  status: TaskState,
  objective: z.string(),
  provider: Provider,
  createdAt: z.string(),
  evidence: z.array(Evidence),
  effects: z.array(z.string()),
  limitations: z.array(z.string()),
  summary: z.string(),
  costUsd: z.number().nullable(),
})
export type ActionReceipt = z.infer<typeof ActionReceipt>

export const MemoryRecord = z.object({
  id: z.string(),
  scope: Scope,
  category: z.enum(['episodic', 'semantic', 'procedural']),
  text: z.string().min(1).max(20_000),
  source: z.string(),
  sourceIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  explicit: z.boolean(),
  reviewState: z.enum(['approved', 'proposed']),
  supersedes: z.string().optional(),
})
export type MemoryRecord = z.infer<typeof MemoryRecord>
export const Observation = z.object({
  id: z.string(),
  windowId: z.number().int(),
  app: z.string(),
  title: z.string(),
  capturedAt: z.string(),
  expiresAt: z.string(),
  width: z.number(),
  height: z.number(),
  selectedText: z.string().optional(),
  imagePath: z.string().optional(),
  preview: z.string().optional(),
  following: z.boolean().default(false),
})
export type Observation = z.infer<typeof Observation>
/** A connected note vault is indexed for recall; the notes themselves stay in their folder. */
export type VaultStatus = {
  path?: string
  scope: string
  notes: number
  chunks: number
  embedded: number
  bytes: number
  skipped: number
  redacted: number
  syncing: boolean
  stage?: string
  lastSyncedAt?: string
  error?: string
}
export type VaultExcerpt = {
  id: string
  path: string
  title: string
  heading: string
  text: string
}
export const AdapterCapabilities = z.object({
  liveSteering: z.boolean(),
  resume: z.boolean(),
  approvals: z.boolean(),
  readOnly: z.boolean(),
  filesystemBoundary: z.boolean(),
  networkBoundary: z.boolean(),
  usage: z.boolean(),
})
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>

export const Settings = z.object({
  shortcut: z.string().min(1).max(80).default('CommandOrControl+Shift+J'),
  pinned: z.boolean().default(false),
  reduceMotion: z.boolean().default(false),
  reduceTransparency: z.boolean().default(false),
  speakReplies: z.boolean().default(true),
  automaticEndpointing: z.boolean().default(false),
  conversationEngine: z.enum(['pipeline', 'duplex', 'realtime']).default('pipeline'),
  handsFree: z.boolean().default(false),
  voice: z.string().default('bm_george'),
  voiceSpeed: z.number().min(0.7).max(1.4).default(1),
  privacyMode: z.enum(['local-first', 'local-only']).default('local-first'),
  defaultProvider: Provider.default('local'),
  startAtLogin: z.boolean().default(false),
  transcriptDays: z.number().int().min(0).max(365).default(30),
  receiptDays: z.number().int().min(1).max(3650).default(90),
  onboardingComplete: z.boolean().default(false),
  budget: Budget.default({ maxSteps: 30, timeoutMs: 1_200_000, maxCostUsd: null }),
  excludedApps: z
    .array(z.string())
    .default(['com.apple.keychainaccess', 'com.1password.1password', 'com.agilebits.onepassword7']),
})
export type Settings = z.infer<typeof Settings>
// Zod defaults apply inside optional schemas; remove them for sparse patches.
const SettingsPatch = z.object(
  Object.fromEntries(
    Object.entries(Settings.shape).map(([key, schema]) => [key, schema.removeDefault().optional()]),
  ) as {
    [K in keyof typeof Settings.shape]: z.ZodOptional<
      ReturnType<(typeof Settings.shape)[K]['removeDefault']>
    >
  },
)
export const OverlayForm = z.enum([
  'orb',
  'menu',
  'input',
  'conversation',
  'task',
  'approval',
  'context',
])
export type OverlayForm = z.infer<typeof OverlayForm>
export type VoicePhase = 'off' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'
export type VoiceStatus = {
  phase: VoicePhase
  level: number
  partial: string
  error?: string
  generation: number
  /** Whether a hands-free session is running, so the microphone opens again after each reply. */
  handsFree: boolean
}
export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  scope: string
  sources?: { id: string; label: string }[]
  streaming?: boolean
}
export type Project = {
  id: string
  name: string
  path: string
  trusted: boolean
  checks: string[]
  createdAt: string
}
export const Routine = z.object({
  id: z.string(),
  name: z.string().min(1).max(160),
  instruction: z.string().min(1).max(4000),
  scope: Scope,
  provider: Provider.default('local'),
  enabled: z.boolean(),
  trigger: z.discriminatedUnion('type', [
    z.object({ type: z.literal('manual') }),
    z.object({ type: z.literal('schedule'), cron: z.string().min(1).max(100) }),
    z.object({ type: z.literal('watch'), projectId: z.string() }),
  ]),
  budget: Budget,
  createdAt: z.string(),
  lastRun: z.string().optional(),
  lastTaskId: z.string().optional(),
})
export type Routine = z.infer<typeof Routine>
export type ConnectionId =
  | 'codex'
  | 'claude'
  | 'openai-realtime'
  | 'automation'
  | 'apple-calendar'
  | 'apple-reminders'
  | 'apple-mail'
  | 'google'
  | 'browser'
  | 'mcp'
export type Connection = {
  id: ConnectionId
  name: string
  description: string
  status: 'connected' | 'disconnected' | 'connecting' | 'error'
  detail?: string
  capabilities: string[]
}
export type ModelRole =
  'asr' | 'tts' | 'reasoning' | 'embedding' | 'vad' | 'turn' | 'duplex' | 'vision'
export type ModelRecord = {
  id: string
  name: string
  repository: string
  role: ModelRole
  description: string
  sizeLabel: string
  status: 'absent' | 'installing' | 'installed' | 'error'
  revision?: string
  progress?: number
  error?: string
  experimental: boolean
  /** Whether the model worker has a load path for this role at all. */
  installable: boolean
  qualified: boolean
  license: string
}
/** What a model check observed on this Mac. Every entry is a result, never a prediction. */
export type QualificationCheck = { label: string; value: string; passed: boolean }
export type QualificationResult = {
  id: string
  role: ModelRole
  revision: string
  qualified: boolean
  checks: QualificationCheck[]
  elapsedSeconds: number
  detail: string
}
export type WindowChoice = { id: number; app: string; title: string; bundleId: string }
export type Diagnostics = {
  platform: string
  chip: string
  memoryGB: number
  appMemoryMB: number
  glass: boolean
  locked: boolean
  native: boolean
  modelRuntime: boolean
  databaseEncrypted: boolean
  shortcutError?: string
  workerErrors: string[]
}
export type Permissions = {
  microphone: string
  screen: string
  accessibility: boolean
  calendars?: string
  reminders?: string
}
export type AppSnapshot = {
  version: 1
  settings: Settings
  voice: VoiceStatus
  tasks: Task[]
  events: TaskEvent[]
  approvals: Approval[]
  receipts: ActionReceipt[]
  messages: Message[]
  memories: MemoryRecord[]
  routines: Routine[]
  projects: Project[]
  activeProjectId?: string
  selectedTaskId?: string
  observation?: Observation
  vault: VaultStatus
  connections: Connection[]
  models: ModelRecord[]
  permissions: Permissions
  diagnostics: Diagnostics
}

const id = z.string().min(1).max(160)
export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('surface.ready') }),
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('settings.update'), patch: SettingsPatch }),
  z.object({ type: z.literal('settings.open'), section: z.string().optional() }),
  z.object({ type: z.literal('overlay.form'), form: OverlayForm }),
  z.object({
    type: z.literal('overlay.drag'),
    phase: z.enum(['start', 'move', 'end']),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({ type: z.literal('overlay.interaction'), active: z.boolean() }),
  z.object({ type: z.literal('overlay.dock'), edge: z.enum(['left', 'right', 'top', 'bottom']) }),
  z.object({ type: z.literal('voice.toggle') }),
  z.object({ type: z.literal('voice.stopSpeech') }),
  z.object({ type: z.literal('voice.audition') }),
  z.object({
    type: z.literal('conversation.send'),
    text: z.string().trim().min(1).max(30_000),
    provider: Provider.optional(),
    projectId: id.optional(),
  }),
  z.object({
    type: z.literal('task.create'),
    objective: z.string().trim().min(1).max(30_000),
    provider: Provider,
    projectId: id.optional(),
  }),
  z.object({ type: z.literal('task.select'), id }),
  z.object({ type: z.literal('task.export'), id }),
  z.object({
    type: z.literal('task.control'),
    id,
    action: z.enum(['pause', 'resume', 'cancel', 'reconcile']),
  }),
  z.object({
    type: z.literal('task.steer'),
    id,
    revision: z.number().int(),
    text: z.string().trim().min(1).max(10_000),
  }),
  z.object({
    type: z.literal('approval.decide'),
    id,
    decision: z.enum(['approved', 'denied']),
    argumentHash: z.string(),
  }),
  z.object({ type: z.literal('project.add') }),
  z.object({ type: z.literal('project.select'), id: id.nullable() }),
  z.object({
    type: z.literal('project.update'),
    id,
    checks: z.array(z.string().trim().min(1).max(1000)).max(10),
    trusted: z.boolean(),
  }),
  z.object({ type: z.literal('project.remove'), id }),
  z.object({
    type: z.literal('memory.save'),
    id: id.optional(),
    text: z.string().trim().min(1).max(20_000),
    scope: Scope,
    category: z.enum(['semantic', 'episodic', 'procedural']),
  }),
  z.object({ type: z.literal('memory.delete'), id }),
  z.object({ type: z.literal('memory.approve'), id }),
  z.object({ type: z.literal('memory.search'), query: z.string().max(1000), scope: Scope }),
  z.object({ type: z.literal('routine.save'), routine: Routine }),
  z.object({ type: z.literal('routine.delete'), id }),
  z.object({ type: z.literal('routine.run'), id }),
  z.object({
    type: z.literal('connection.connect'),
    id: z.enum([
      'codex',
      'claude',
      'openai-realtime',
      'automation',
      'apple-calendar',
      'apple-reminders',
      'apple-mail',
      'google',
      'browser',
      'mcp',
    ]),
    config: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal('connection.disconnect'), id: z.string() }),
  z.object({ type: z.literal('connection.inspect'), id: z.string(), query: z.string().optional() }),
  z.object({ type: z.literal('context.windows') }),
  z.object({
    type: z.literal('context.shareText'),
    source: z.string().min(1).max(150),
    text: z.string().min(1).max(30_000),
  }),
  z.object({ type: z.literal('context.select'), windowId: z.number().int().positive() }),
  z.object({ type: z.literal('context.follow'), following: z.boolean() }),
  z.object({ type: z.literal('context.clear') }),
  z.object({ type: z.literal('context.selectRegion') }),
  z.object({ type: z.literal('context.cancelRegion') }),
  // Reported in the selection window's own coordinates; the main process maps them to the screen.
  z.object({
    type: z.literal('context.regionChosen'),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().min(1).max(20_000),
    height: z.number().finite().min(1).max(20_000),
  }),
  z.object({ type: z.literal('vault.choose') }),
  z.object({ type: z.literal('vault.sync') }),
  z.object({ type: z.literal('vault.forget') }),
  z.object({
    type: z.literal('permission.request'),
    permission: z.enum(['microphone', 'screen', 'accessibility', 'calendars', 'reminders']),
  }),
  z.object({ type: z.literal('model.install'), id }),
  z.object({ type: z.literal('model.remove'), id }),
  z.object({ type: z.literal('model.qualify'), id }),
  z.object({ type: z.literal('runtime.setup') }),
  z.object({ type: z.literal('diagnostics.refresh') }),
  z.object({ type: z.literal('diagnostics.export') }),
  z.object({ type: z.literal('data.export') }),
  z.object({ type: z.literal('app.quit') }),
])
export type Command = z.infer<typeof Command>
export type Result<T = unknown> =
  { ok: true; value: T } | { ok: false; error: string; code?: string }
export type AppEvent =
  | { type: 'snapshot'; snapshot: AppSnapshot }
  | { type: 'notice'; tone: 'info' | 'success' | 'error'; message: string }
  | { type: 'overlay'; form: OverlayForm }
  | { type: 'section'; section: string }
export interface JarvisAPI {
  command<T = unknown>(command: Command): Promise<T>
  subscribe(listener: (event: AppEvent) => void): () => void
  surface: 'overlay' | 'settings' | 'preview'
}

declare global {
  interface Window {
    jarvis: JarvisAPI
  }
}
