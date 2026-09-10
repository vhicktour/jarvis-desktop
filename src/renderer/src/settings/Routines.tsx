import { useState } from 'react'
import { Clock3, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { Routine, Provider } from '../../../shared/contracts'
import { useJarvis } from '../state'
import { Button, Choice, Empty, Field, IconButton } from '../ui'

export function Routines() {
  const { snapshot, command } = useJarvis()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [schedule, setSchedule] = useState('manual')
  const [time, setTime] = useState('09:00')
  const [scope, setScope] = useState(snapshot.activeProjectId ?? 'personal')
  const [provider, setProvider] = useState<Provider>('local')
  const save = async () => {
    const [hour, minute] = time.split(':').map(Number)
    const routine: Routine = {
      id: crypto.randomUUID(),
      name,
      instruction,
      scope,
      provider,
      enabled: true,
      trigger:
        schedule === 'daily'
          ? { type: 'schedule', cron: `${minute} ${hour} * * *` }
          : schedule === 'watch'
            ? { type: 'watch', projectId: scope }
            : { type: 'manual' },
      budget: snapshot.settings.budget,
      createdAt: new Date().toISOString(),
    }
    const result = await command({ type: 'routine.save', routine })
    if (result !== undefined) {
      setCreating(false)
      setName('')
      setInstruction('')
    }
  }
  return (
    <>
      <div className="section-toolbar">
        <p className="muted">Small habits. Thoughtfully handled.</p>
        <Button variant="primary" onPress={() => setCreating(true)}>
          <Plus size={14} />
          New routine
        </Button>
      </div>
      {creating && (
        <div className="editor-card">
          <Field
            label="Routine name"
            value={name}
            onChange={setName}
            placeholder="A moment to plan tomorrow"
          />
          <Field
            label="What should Jarvis do?"
            value={instruction}
            onChange={setInstruction}
            multiline
          />
          <div className="form-grid">
            <Choice
              label="When"
              value={schedule}
              options={[
                { id: 'manual', label: 'When I ask' },
                { id: 'daily', label: 'Every day' },
                ...(scope !== 'personal'
                  ? [{ id: 'watch', label: 'When this repository changes' }]
                  : []),
              ]}
              onChange={setSchedule}
            />
            {schedule === 'daily' && (
              <Field label="Local time" type="time" value={time} onChange={setTime} />
            )}
          </div>
          <div className="form-grid">
            <Choice
              label="Scope"
              value={scope}
              onChange={(value) => {
                setScope(value)
                if (value === 'personal') {
                  setSchedule('manual')
                  setProvider('local')
                }
              }}
              options={[
                { id: 'personal', label: 'Personal' },
                ...snapshot.projects
                  .filter((p) => p.trusted)
                  .map((p) => ({ id: p.id, label: p.name })),
              ]}
            />
            <Choice
              label="Assistant"
              value={provider}
              onChange={(value) => setProvider(value as Provider)}
              options={[
                { id: 'local', label: 'On this Mac' },
                ...(scope !== 'personal'
                  ? [
                      { id: 'codex', label: 'Codex + Claude review' },
                      { id: 'claude', label: 'Claude review' },
                    ]
                  : []),
              ]}
            />
          </div>
          <p className="field-help">
            Runs use the current usage ceiling and stop after{' '}
            {Math.round(snapshot.settings.budget.timeoutMs / 60_000)} minutes. Every effect still
            needs its own approval. Scheduled runs require Jarvis to be running.
          </p>
          <div className="actions">
            <Button variant="ghost" onPress={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isDisabled={!name.trim() || !instruction.trim()}
              onPress={() => {
                void save()
              }}
            >
              Create routine
            </Button>
          </div>
        </div>
      )}
      {snapshot.routines.length ? (
        snapshot.routines.map((routine) => (
          <div className="routine-row" key={routine.id}>
            <Clock3 size={20} />
            <div>
              <h3>{routine.name}</h3>
              <p>{routine.instruction}</p>
              <span className="metadata">
                {routine.trigger.type === 'manual'
                  ? 'ON REQUEST'
                  : routine.trigger.type === 'schedule'
                    ? `SCHEDULED · ${routine.trigger.cron}`
                    : 'WATCHING REPOSITORY'}{' '}
                · {routine.enabled ? 'ENABLED' : 'PAUSED'}
              </span>
            </div>
            <Button
              isDisabled={!routine.enabled}
              onPress={() => {
                void command({ type: 'routine.run', id: routine.id })
              }}
            >
              Run
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                void command({
                  type: 'routine.save',
                  routine: { ...routine, enabled: !routine.enabled },
                })
              }}
            >
              {routine.enabled ? 'Pause' : 'Enable'}
            </Button>
            <IconButton
              label={`Delete ${routine.name}`}
              onPress={() => {
                void command({ type: 'routine.delete', id: routine.id })
              }}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))
      ) : (
        <Empty
          icon={<Sparkles size={26} />}
          title="Make room for what matters."
          detail="Create a routine for a recurring question or a small task. Each run keeps its scope, budget, and approval requirements."
        />
      )}
    </>
  )
}
