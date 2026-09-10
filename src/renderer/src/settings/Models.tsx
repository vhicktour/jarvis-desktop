import { ArrowUpRight, BrainCircuit, Check, Download, HardDrive, Trash2 } from 'lucide-react'
import type { ModelRecord } from '../../../shared/contracts'
import { useJarvis } from '../state'
import { Badge, Button, Confirm, Group, IconButton, Row } from '../ui'

function ModelRow({ model }: { model: ModelRecord }) {
  const { command, busy } = useJarvis()
  return (
    <div className="model-row">
      <div className={`model-symbol ${model.role}`}>
        <BrainCircuit size={18} />
      </div>
      <div className="model-info">
        <div>
          <h3>{model.name}</h3>
          <span className="model-role">{model.role}</span>
        </div>
        <p>{model.description}</p>
        <span className="metadata">
          {model.sizeLabel} · {model.license}
        </span>
        {model.error && <p className="error-text">{model.error}</p>}
        {model.status === 'installed' && (
          <span className="model-revision">
            {model.revision?.slice(0, 10)} ·{' '}
            {model.qualified ? 'Qualified on this Mac' : 'Installed · qualification pending'}
          </span>
        )}
      </div>
      <div className="model-actions">
        {model.status === 'installed' ? (
          <>
            <IconButton
              label={`Check ${model.name}`}
              onPress={() => {
                void command({ type: 'model.qualify', id: model.id })
              }}
            >
              <Check size={15} />
            </IconButton>
            <Confirm
              title={`Remove ${model.name}?`}
              description="The downloaded weights will be removed. Your conversations and memories remain available."
              action="Remove model"
              destructive
              trigger={
                <IconButton label={`Remove ${model.name}`}>
                  <Trash2 size={14} />
                </IconButton>
              }
              onConfirm={() => {
                void command({ type: 'model.remove', id: model.id })
              }}
            />
          </>
        ) : (
          <Button
            isDisabled={model.experimental || model.status === 'installing'}
            busy={model.status === 'installing'}
            onPress={() => {
              void command({ type: 'model.install', id: model.id })
            }}
          >
            {model.experimental ? (
              'Research'
            ) : model.status === 'installing' ? (
              'Installing'
            ) : model.status === 'error' ? (
              'Retry'
            ) : (
              <>
                <Download size={13} />
                Install
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

export function Models() {
  const { snapshot, command } = useJarvis()
  return (
    <>
      <div className="system-banner">
        <div className="system-symbol">
          <HardDrive size={24} />
        </div>
        <div>
          <h2>Made for your Mac.</h2>
          <p>
            {snapshot.diagnostics.chip} · {snapshot.diagnostics.memoryGB || 16} GB unified memory
          </p>
        </div>
        <Badge tone={snapshot.diagnostics.modelRuntime ? 'active' : 'attention'}>
          {snapshot.diagnostics.modelRuntime ? 'Runtime ready' : 'Setup needed'}
        </Badge>
      </div>
      {!snapshot.diagnostics.modelRuntime && (
        <Row
          title="Local model runtime"
          description="A private Python environment with pinned MLX dependencies."
        >
          <Button
            variant="primary"
            onPress={() => {
              void command({ type: 'runtime.setup' })
            }}
          >
            Set up runtime
            <ArrowUpRight size={13} />
          </Button>
        </Row>
      )}
      <Group
        title="Everyday intelligence"
        detail="Install the capabilities you want. Model downloads are pinned to an exact revision."
      >
        {snapshot.models
          .filter((m) => !m.experimental)
          .map((model) => (
            <ModelRow key={model.id} model={model} />
          ))}
      </Group>
      <Group
        title="On the horizon"
        detail="Research profiles stay disabled until their Mac-specific tests pass."
      >
        {snapshot.models
          .filter((m) => m.experimental)
          .map((model) => (
            <ModelRow key={model.id} model={model} />
          ))}
      </Group>
      <p className="fine-print">
        Models run in a separate process without provider credentials. Large inference jobs run one
        at a time to leave room for the rest of your Mac.
      </p>
    </>
  )
}
