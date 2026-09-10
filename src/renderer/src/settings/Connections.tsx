import { useState } from 'react'
import { Check, ChevronRight, FolderGit2, KeyRound, Plus, X } from 'lucide-react'
import type { Connection } from '../../../shared/contracts'
import { useJarvis } from '../state'
import { Button, Field, Group, IconButton, Row } from '../ui'

function ConnectionRow({ connection }: { connection: Connection }) {
  const { command, busy } = useJarvis()
  const [expanded, setExpanded] = useState(false)
  const [key, setKey] = useState('')
  const [clientId, setClientId] = useState('')
  const [detail, setDetail] = useState<string>()
  const connected = connection.status === 'connected'
  const connect = async () => {
    const result = await command({
      type: 'connection.connect',
      id: connection.id,
      config:
        connection.id === 'claude'
          ? { apiKey: key }
          : connection.id === 'google'
            ? { clientId, clientSecret: key }
            : connection.id === 'mcp'
              ? { command: clientId, args: key }
              : {},
    })
    if (result !== undefined) {
      setKey('')
      setExpanded(false)
    }
  }
  return (
    <div className="connection-block">
      <div className="connection-row">
        <div className={`connection-icon ${connection.id}`}>
          <span>
            {connection.id === 'codex'
              ? '◈'
              : connection.id === 'claude'
                ? '✳'
                : connection.id === 'google'
                  ? 'G'
                  : connection.id === 'apple-calendar'
                    ? '10'
                    : connection.id === 'apple-reminders'
                      ? '≡'
                      : connection.id === 'apple-mail'
                        ? '@'
                        : connection.id === 'mcp'
                          ? '⌁'
                          : '◎'}
          </span>
        </div>
        <div>
          <h3>{connection.name}</h3>
          <p>{connection.description}</p>
          <div className="connection-tags">
            {connection.capabilities.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          {connection.detail && (
            <p className={connection.status === 'error' ? 'error-text' : 'connection-detail'}>
              {connection.detail}
            </p>
          )}
        </div>
        <Button
          variant={connected ? 'ghost' : 'secondary'}
          busy={connection.status === 'connecting'}
          onPress={() => {
            if (connected || ['claude', 'google', 'mcp'].includes(connection.id))
              setExpanded(!expanded)
            else void connect()
          }}
        >
          {connected ? (
            <>
              <span className="connected-dot" />
              Connected
              <ChevronRight size={12} />
            </>
          ) : (
            'Connect'
          )}
        </Button>
      </div>
      {expanded && (
        <div className="connection-form">
          {connected ? (
            <div className="actions">
              <Button
                onPress={async () => {
                  const result = await command({ type: 'connection.inspect', id: connection.id })
                  if (result !== undefined) setDetail(JSON.stringify(result, null, 2))
                }}
              >
                Inspect connection
              </Button>
              <Button
                variant="ghost"
                onPress={() => {
                  void command({ type: 'connection.disconnect', id: connection.id })
                  setExpanded(false)
                }}
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <>
              {connection.id === 'google' && (
                <Field
                  label="Google OAuth desktop client ID"
                  value={clientId}
                  onChange={setClientId}
                />
              )}
              {connection.id === 'mcp' && (
                <Field
                  label="Absolute server executable"
                  value={clientId}
                  onChange={setClientId}
                  description="Only connect a local server you have reviewed and trust."
                />
              )}
              <Field
                label={
                  connection.id === 'claude'
                    ? 'Anthropic API key'
                    : connection.id === 'google'
                      ? 'OAuth client secret'
                      : 'Arguments (JSON array)'
                }
                value={key}
                onChange={setKey}
                type={connection.id === 'mcp' ? 'text' : 'password'}
                description={
                  connection.id === 'mcp'
                    ? 'Connected tools are inspected before any execution is enabled.'
                    : 'Stored in your macOS Keychain.'
                }
              />
              <div className="actions">
                <Button
                  variant="primary"
                  busy={busy.has('connection.connect')}
                  onPress={() => {
                    void connect()
                  }}
                >
                  Connect securely
                  <KeyRound size={13} />
                </Button>
              </div>
            </>
          )}
          {detail && <pre className="payload">{detail}</pre>}
          {detail &&
            ['apple-calendar', 'apple-reminders', 'apple-mail', 'google'].includes(
              connection.id,
            ) && (
              <Button
                onPress={async () => {
                  const result = await command({
                    type: 'context.shareText',
                    source: connection.name,
                    text: detail.slice(0, 30_000),
                  })
                  if (result !== undefined)
                    await command({ type: 'overlay.form', form: 'conversation' })
                }}
              >
                Share this snapshot with Jarvis
              </Button>
            )}
        </div>
      )}
    </div>
  )
}

export function Connections() {
  const { snapshot, command } = useJarvis()
  const [ceiling, setCeiling] = useState(snapshot.settings.budget.maxCostUsd?.toString() ?? '')
  return (
    <>
      <Group
        title="Specialists"
        detail="Cloud work begins only after you choose a provider and a usage ceiling."
      >
        {snapshot.connections
          .filter((c) => ['codex', 'claude'].includes(c.id))
          .map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} />
          ))}
        <Row
          title="Maximum spend per task"
          description="Tasks stop at their configured usage or time ceiling."
        >
          <div className="budget-input">
            <span>$</span>
            <input
              aria-label="Maximum spend per task in dollars"
              type="number"
              min="0.01"
              max="1000"
              step="0.25"
              placeholder="Not set"
              value={ceiling}
              onChange={(e) => setCeiling(e.target.value)}
              onBlur={() => {
                void command({
                  type: 'settings.update',
                  patch: {
                    budget: {
                      ...snapshot.settings.budget,
                      maxCostUsd: ceiling ? Number(ceiling) : null,
                    },
                  },
                })
              }}
            />
          </div>
        </Row>
      </Group>
      <Group
        title="Repositories"
        detail="Choose the checkout. Jarvis prepares an isolated worktree for each coding task."
      >
        {snapshot.projects.map((project) => (
          <div className="project-row" key={project.id}>
            <FolderGit2 size={19} />
            <div>
              <strong>{project.name}</strong>
              <span>{project.path}</span>
              <input
                aria-label={`Checks for ${project.name}`}
                placeholder="Verification command, e.g. pnpm test"
                defaultValue={project.checks.join('\n')}
                onBlur={(event) => {
                  void command({
                    type: 'project.update',
                    id: project.id,
                    checks: event.target.value.split('\n').filter(Boolean),
                    trusted: project.trusted,
                  })
                }}
              />
            </div>
            <Button
              variant={snapshot.activeProjectId === project.id ? 'ghost' : 'secondary'}
              onPress={() => {
                void command({ type: 'project.select', id: project.id })
              }}
            >
              {snapshot.activeProjectId === project.id ? <Check size={15} /> : 'Select'}
            </Button>
            <IconButton
              label={`Remove ${project.name}`}
              onPress={() => {
                void command({ type: 'project.remove', id: project.id })
              }}
            >
              <X size={14} />
            </IconButton>
          </div>
        ))}
        <Button
          onPress={() => {
            void command({ type: 'project.add' })
          }}
        >
          <Plus size={14} />
          Choose repository
        </Button>
      </Group>
      <Group title="Your everyday tools">
        {snapshot.connections
          .filter((c) => !['codex', 'claude'].includes(c.id))
          .map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} />
          ))}
      </Group>
    </>
  )
}
