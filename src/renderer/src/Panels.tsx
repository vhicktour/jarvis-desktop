import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Liquid } from 'liquid-gooey'
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Crop,
  Eye,
  FileText,
  Keyboard,
  MessageCircle,
  Mic,
  Pause,
  Pin,
  Play,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  VolumeX,
  X,
} from 'lucide-react'
import type { Provider, WindowChoice } from '../../shared/contracts'
import { useJarvis } from './state'
import { Core, useActivity } from './Orb'
import { Badge, Button, Choice, Empty, Field, IconButton, Notices } from './ui'

function Header({ title, label }: { title: string; label?: string }) {
  const { command } = useJarvis()
  return (
    <header className="panel-header">
      <div>
        <span className="eyebrow">{label ?? 'JARVIS'}</span>
        <h1>{title}</h1>
      </div>
      <IconButton
        label="Close panel"
        onPress={() => {
          void command({ type: 'overlay.form', form: 'orb' })
        }}
      >
        <X size={16} />
      </IconButton>
    </header>
  )
}
function MenuPanel() {
  const { command, snapshot } = useJarvis()
  const activity = useActivity()
  const items = [
    {
      icon: Mic,
      title: snapshot.voice.phase === 'listening' ? 'Finish speaking' : 'Talk to Jarvis',
      action: () => {
        void command({ type: 'voice.toggle' })
        void command({ type: 'overlay.form', form: 'orb' })
      },
    },
    // The only way to silence a reply without the orb; hands-free ends here too.
    ...(snapshot.voice.phase === 'speaking'
      ? [
          {
            icon: VolumeX,
            title: 'Stop speaking',
            action: () => command({ type: 'voice.stopSpeech' }),
          },
        ]
      : []),
    {
      icon: Keyboard,
      title: 'Type a thought',
      action: () => command({ type: 'overlay.form', form: 'input' }),
    },
    {
      icon: MessageCircle,
      title: 'Recent conversation',
      action: () => command({ type: 'overlay.form', form: 'conversation' }),
    },
    {
      icon: Clock3,
      title: 'Current task',
      action: () => command({ type: 'overlay.form', form: 'task' }),
    },
    {
      icon: Eye,
      title: 'Share a window',
      action: () => command({ type: 'overlay.form', form: 'context' }),
    },
  ]
  return (
    <div className="menu-panel">
      <div className="menu-identity">
        <div>
          <span className="wordmark">
            JARVIS<span>°</span>
          </span>
          <p>{activity.label}</p>
        </div>
        <IconButton
          label={snapshot.settings.pinned ? 'Unpin orb' : 'Pin orb'}
          onPress={() => {
            void command({ type: 'settings.update', patch: { pinned: !snapshot.settings.pinned } })
          }}
        >
          <Pin size={14} className={snapshot.settings.pinned ? 'cyan' : ''} />
        </IconButton>
      </div>
      <nav aria-label="Jarvis controls">
        {items.map(({ icon: Icon, title, action }) => (
          <Button
            key={title}
            variant="ghost"
            className="menu-item"
            onPress={() => {
              void action()
            }}
          >
            <Icon size={15} />
            <span>{title}</span>
            <ChevronRight size={12} />
          </Button>
        ))}
      </nav>
      <div className="menu-bottom">
        <Button
          variant="ghost"
          className="menu-item"
          onPress={() => {
            void command({ type: 'settings.open' })
          }}
        >
          <Settings2 size={15} />
          <span>Settings</span>
          <span className="keycap">⌘ ,</span>
        </Button>
      </div>
      <Notices />
    </div>
  )
}
function Composer({ compact = false }: { compact?: boolean }) {
  const { snapshot, command, busy } = useJarvis()
  const [text, setText] = useState('')
  const [provider, setProvider] = useState<string>(snapshot.settings.defaultProvider)
  const send = async () => {
    if (!text.trim()) return
    const result = await command(
      provider === 'local-task'
        ? {
            type: 'task.create',
            objective: text,
            provider: 'local',
            projectId: snapshot.activeProjectId,
          }
        : {
            type: 'conversation.send',
            text,
            provider: provider as Provider,
            projectId: snapshot.activeProjectId,
          },
    )
    if (result !== undefined) setText('')
  }
  return (
    <div className={`composer ${compact ? 'compact' : ''}`}>
      <label className="sr-only" htmlFor="thought">
        Your thought
      </label>
      <textarea
        className="resize-none"
        id="thought"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="What’s on your mind?"
        autoFocus
        rows={compact ? 3 : 2}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
        }}
      />
      <div className="composer-bottom">
        <Choice
          label="Think with"
          value={provider}
          onChange={(value) => setProvider(value as Provider)}
          options={[
            { id: 'local', label: 'On this Mac' },
            { id: 'local-task', label: 'Local task' },
            { id: 'codex', label: 'Codex task' },
            { id: 'claude', label: 'Claude task' },
          ]}
        />
        <Button
          variant="primary"
          className="send-button"
          aria-label="Send message"
          isDisabled={!text.trim()}
          busy={busy.has('conversation.send') || busy.has('task.create')}
          onPress={() => {
            void send()
          }}
        >
          <ArrowUp size={18} />
        </Button>
      </div>
    </div>
  )
}
function ConversationPanel({ input = false }: { input?: boolean }) {
  const { snapshot } = useJarvis()
  const bottom = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    if (following.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [snapshot.messages.at(-1)?.text])
  return (
    <>
      <Header
        title={input ? 'A thought, a question, a task.' : 'Our conversation'}
        label={snapshot.activeProjectId ? 'PROJECT CONTEXT' : 'PRIVATE CONVERSATION'}
      />
      {!input && (
        <div
          className="conversation-scroll scroll-area"
          onScroll={(event) => {
            const el = event.currentTarget
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
        >
          {snapshot.messages.length ? (
            snapshot.messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span className="message-author">{message.role === 'user' ? 'You' : 'Jarvis'}</span>
                <p>
                  {message.text}
                  {message.streaming && <span className="text-cursor" />}
                </p>
                {!!message.sources?.length && (
                  <div className="message-sources">
                    {message.sources.map((source) => (
                      <span key={source.id}>
                        <FileText size={10} />
                        {source.label}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))
          ) : (
            <Empty
              icon={<MessageCircle size={22} />}
              title="A little space to think."
              detail="Your conversations stay on this Mac when you use the local model."
            />
          )}
          <div ref={bottom} />
        </div>
      )}
      <Composer compact={input} />
      <Notices />
    </>
  )
}
function TaskPanel() {
  const { snapshot, command } = useJarvis()
  const [steering, setSteering] = useState('')
  const [inspection, setInspection] = useState<unknown>()
  const task = snapshot.tasks.find((t) => t.id === snapshot.selectedTaskId) ?? snapshot.tasks[0]
  const receipt = snapshot.receipts.find(
    (item) => item.taskId === task?.id && item.revision === task?.revision,
  )
  const events = snapshot.events.filter((e) => e.taskId === task?.id)
  return (
    <>
      <Header
        title={
          task?.state === 'completed'
            ? 'Ready for you.'
            : task?.state === 'failed' || task?.state === 'needs_reconciliation'
              ? 'Needs a look.'
              : task
                ? 'On it.'
                : 'Nothing in flight.'
        }
        label="TASK DETAILS"
      />
      <div className="panel-scroll scroll-area">
        {task ? (
          <>
            {snapshot.tasks.length > 1 && (
              <Choice
                label="Recent tasks"
                value={task.id}
                options={snapshot.tasks.map((item) => ({
                  id: item.id,
                  label: item.objective.slice(0, 70),
                }))}
                onChange={(id) => {
                  setInspection(undefined)
                  void command({ type: 'task.select', id })
                }}
              />
            )}
            <Badge
              tone={
                task.state === 'completed'
                  ? 'active'
                  : task.state === 'failed'
                    ? 'error'
                    : 'neutral'
              }
            >
              {task.state.replaceAll('_', ' ')}
            </Badge>
            <h2 className="task-objective">{task.objective}</h2>
            <div className="task-meta">
              <span>{task.provider}</span>
              <span>Revision {task.revision}</span>
            </div>
            <div className="timeline">
              {events.slice(-8).map((event, index) => (
                <div className="timeline-item" key={event.id}>
                  <span className={index === events.length - 1 ? 'current' : ''} />
                  <div>
                    <p>{event.message}</p>
                    <time>
                      {new Date(event.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                </div>
              ))}
            </div>
            {task.evidence.map((evidence) => (
              <details className="evidence" key={evidence.id}>
                <summary>
                  {evidence.verified ? <Check size={13} /> : <Clock3 size={13} />}
                  {evidence.label}
                </summary>
                <pre>{evidence.value}</pre>
              </details>
            ))}
            {task.error && <p className="error-text">{task.error}</p>}
            {task.worktree && (
              <div className="evidence">
                <span className="metadata">ISOLATED WORKTREE</span>
                <pre>{task.worktree}</pre>
              </div>
            )}
            {receipt && (
              <div className="receipt-notes">
                <p>{receipt.summary}</p>
                {receipt.limitations.length > 0 && (
                  <ul>
                    {receipt.limitations.map((limitation, index) => (
                      <li key={index}>{limitation}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {inspection !== undefined && (
              <pre className="payload">{JSON.stringify(inspection, null, 2)}</pre>
            )}
            {task.state === 'needs_reconciliation' && (
              <div className="inline-note">
                <ShieldCheck size={16} />
                <p>
                  An action was interrupted after dispatch. Inspect its destination and ledger
                  before starting a replacement. Closing this task never retries it.
                </p>
              </div>
            )}
            <div className="actions">
              <Button
                variant="ghost"
                onPress={() => {
                  void command({ type: 'task.export', id: task.id })
                }}
              >
                <FileText size={13} />
                Export receipt & effects
              </Button>
            </div>
            {![
              'completed',
              'failed',
              'cancelled',
              'needs_reconciliation',
              'pausing',
              'cancel_requested',
            ].includes(task.state) && (
              <>
                <Field
                  label="Steer this task"
                  value={steering}
                  onChange={setSteering}
                  placeholder="A change of direction…"
                />
                <div className="actions">
                  <Button
                    isDisabled={!steering.trim()}
                    onPress={async () => {
                      const result = await command({
                        type: 'task.steer',
                        id: task.id,
                        revision: task.revision,
                        text: steering,
                      })
                      if (result !== undefined) setSteering('')
                    }}
                  >
                    Send instruction
                    <ArrowUpRight size={13} />
                  </Button>
                </div>
              </>
            )}
          </>
        ) : (
          <Empty
            icon={<Clock3 size={22} />}
            title="Ready for the next thing."
            detail="Choose a repository and a connected specialist to begin a coding task."
          >
            <Button
              onPress={() => {
                void command({ type: 'settings.open', section: 'connections' })
              }}
            >
              Set up a connection
              <ArrowUpRight size={13} />
            </Button>
          </Empty>
        )}
      </div>
      {task && !['completed', 'failed', 'cancelled'].includes(task.state) && (
        <footer className="panel-footer">
          <Button
            isDisabled={['pausing', 'cancel_requested'].includes(task.state)}
            onPress={async () => {
              const result = await command({
                type: 'task.control',
                id: task.id,
                action:
                  task.state === 'needs_reconciliation'
                    ? 'reconcile'
                    : task.state === 'paused'
                      ? 'resume'
                      : 'pause',
              })
              if (task.state === 'needs_reconciliation' && result !== undefined)
                setInspection(result)
            }}
          >
            {task.state === 'paused' ? <Play size={13} /> : <Pause size={13} />}
            {task.state === 'needs_reconciliation'
              ? 'Inspect effects'
              : task.state === 'paused'
                ? 'Resume'
                : 'Pause'}
          </Button>
          <Button
            variant="ghost"
            onPress={() => {
              void command({ type: 'task.control', id: task.id, action: 'cancel' })
            }}
          >
            <Square size={12} />
            {task.state === 'needs_reconciliation' ? 'Close without retrying' : 'Cancel task'}
          </Button>
        </footer>
      )}
      <Notices />
    </>
  )
}
function ApprovalPanel() {
  const { snapshot, command, busy } = useJarvis()
  const approval = snapshot.approvals[0]
  if (!approval) return <TaskPanel />
  return (
    <>
      <Header title="Your call." label="APPROVAL REQUIRED" />
      <div className="panel-scroll scroll-area">
        <div className="approval-emblem">
          <ShieldCheck size={24} />
        </div>
        <h2 className="task-objective">{approval.proposal.description}</h2>
        <p className="muted">Review the exact scope before Jarvis continues.</p>
        <dl className="approval-facts">
          <dt>Destination</dt>
          <dd>{approval.proposal.target}</dd>
          <dt>Action</dt>
          <dd>{approval.proposal.tool}</dd>
          <dt>Revision</dt>
          <dd>{approval.proposal.revision}</dd>
        </dl>
        <pre className="payload">{JSON.stringify(approval.proposal.arguments, null, 2)}</pre>
        <span className="metadata">
          Expires{' '}
          {new Date(approval.expiresAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
      <footer className="panel-footer">
        <Button
          variant="ghost"
          onPress={() => {
            void command({
              type: 'approval.decide',
              id: approval.id,
              decision: 'denied',
              argumentHash: approval.proposal.argumentHash,
            })
          }}
        >
          Decline
        </Button>
        <Button
          variant="primary"
          busy={busy.has('approval.decide')}
          onPress={() => {
            void command({
              type: 'approval.decide',
              id: approval.id,
              decision: 'approved',
              argumentHash: approval.proposal.argumentHash,
            })
          }}
        >
          Approve action
          <Check size={14} />
        </Button>
      </footer>
      <Notices />
    </>
  )
}
function ContextPanel() {
  const { snapshot, command, busy } = useJarvis()
  const [windows, setWindows] = useState<WindowChoice[]>([])
  const refresh = async () => {
    const result = await command<WindowChoice[]>({ type: 'context.windows' })
    if (result) setWindows(result)
  }
  useEffect(() => {
    if (snapshot.permissions.screen === 'granted') void refresh()
  }, [])
  return (
    <>
      <Header title="A shared point of view." label="SELECTED CONTEXT" />
      <div className="panel-scroll scroll-area">
        {snapshot.observation ? (
          <>
            <Badge tone="active">
              {snapshot.observation.following ? 'Following · 1 frame / sec' : 'Single observation'}
            </Badge>
            {snapshot.observation.preview && (
              <img
                className="context-preview"
                src={snapshot.observation.preview}
                alt={`Selected ${snapshot.observation.app} window`}
              />
            )}
            <h2 className="task-objective">{snapshot.observation.title}</h2>
            <p className="muted">{snapshot.observation.app}</p>
            <div className="actions">
              {snapshot.observation.windowId > 0 && (
                <Button
                  onPress={() => {
                    void command({
                      type: 'context.follow',
                      following: !snapshot.observation?.following,
                    })
                  }}
                >
                  {snapshot.observation.following ? 'Stop following' : 'Follow this window'}
                </Button>
              )}
              <Button
                variant="ghost"
                onPress={() => {
                  void command({ type: 'context.clear' })
                }}
              >
                Stop sharing
              </Button>
            </div>
          </>
        ) : snapshot.permissions.screen !== 'granted' ? (
          <Empty
            icon={<Eye size={24} />}
            title="Choose what I can see."
            detail="Allow Screen Recording, then select a single window to share."
          >
            <Button
              variant="primary"
              onPress={() => {
                void command({ type: 'permission.request', permission: 'screen' })
              }}
            >
              Allow window sharing
            </Button>
          </Empty>
        ) : (
          <>
            <p className="muted">Only what you choose here will be captured.</p>
            <Button
              variant="primary"
              onPress={() => {
                void command({ type: 'context.selectRegion' })
              }}
            >
              <Crop size={13} />
              Draw an area
            </Button>
            <div className="window-list">
              {windows.map((window) => (
                <Button
                  key={window.id}
                  variant="ghost"
                  className="window-option"
                  onPress={() => {
                    void command({ type: 'context.select', windowId: window.id })
                  }}
                >
                  <span className="window-app-icon">
                    <Eye size={16} />
                  </span>
                  <span>
                    <strong>{window.app}</strong>
                    <small>{window.title}</small>
                  </span>
                  <ChevronRight size={14} />
                </Button>
              ))}
            </div>
            <Button
              busy={busy.has('context.windows')}
              onPress={() => {
                void refresh()
              }}
            >
              <Search size={13} />
              Refresh windows
            </Button>
          </>
        )}
      </div>
      <Notices />
    </>
  )
}
export function Panel() {
  const { form, command, snapshot } = useJarvis()
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void command({ type: 'overlay.form', form: 'orb' })
      if (event.metaKey && event.key === ',') void command({ type: 'settings.open' })
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
  return (
    <div
      className="panel-shell"
      onPointerEnter={() => {
        void command({ type: 'overlay.interaction', active: true })
      }}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={form}
          className="panel-content"
          initial={{ opacity: 0, y: snapshot.settings.reduceMotion ? 0 : 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: snapshot.settings.reduceMotion ? 0 : 0.2 }}
        >
          {form === 'menu' || form === 'orb' ? (
            <MenuPanel />
          ) : form === 'input' ? (
            <ConversationPanel input />
          ) : form === 'conversation' ? (
            <ConversationPanel />
          ) : form === 'task' ? (
            <TaskPanel />
          ) : form === 'approval' ? (
            <ApprovalPanel />
          ) : (
            <ContextPanel />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
