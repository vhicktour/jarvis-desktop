import { ArrowUpRight, BrainCircuit, Check, Download, HardDrive, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ModelRecord } from '../../../shared/contracts'
import { LOCAL_VOICE_MODELS, localVoiceReady } from '../../../shared/speech'
import { useJarvis } from '../state'
import { Badge, Button, Confirm, Group, IconButton, Row } from '../ui'

function ModelRow({
  model,
  runtime,
  working,
}: {
  model: ModelRecord
  runtime: boolean
  working: boolean
}) {
  const { command } = useJarvis()
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
            {model.checking
              ? 'Checking…'
              : model.qualified
                ? 'Checks passed on this Mac'
                : 'Installed · check needed'}
          </span>
        )}
      </div>
      <div className="model-actions">
        {model.status === 'installed' ? (
          <>
            <IconButton
              label={`Check ${model.name}`}
              isDisabled={!runtime || working}
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
                <IconButton label={`Remove ${model.name}`} isDisabled={!runtime || working}>
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
            isDisabled={!runtime || !model.installable || working}
            busy={model.status === 'installing'}
            onPress={() => {
              void command({ type: 'model.install', id: model.id })
            }}
          >
            {!model.installable && runtime ? (
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
  const { snapshot, command, busy } = useJarvis()
  const [showMore, setShowMore] = useState(false)
  const runtime = snapshot.diagnostics.modelRuntime
  const working = snapshot.models.some((model) => model.checking || model.status === 'installing')
  const qualified = (id: string) =>
    runtime &&
    snapshot.models.some(
      (model) => model.id === id && model.status === 'installed' && model.qualified,
    )
  const canUseLocal = localVoiceReady(qualified)
  const standard = LOCAL_VOICE_MODELS.flatMap((id) =>
    snapshot.models.filter((model) => model.id === id),
  )
  const optional = snapshot.models.filter((model) => !standard.includes(model))
  return (
    <>
      <div className="system-banner">
        <div className="system-symbol">
          <HardDrive size={24} />
        </div>
        <div>
          <h2>Local conversation.</h2>
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
          description={
            snapshot.diagnostics.workerErrors[0] ??
            'A private Python environment with pinned MLX dependencies.'
          }
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
      <Row
        title={canUseLocal ? 'Local voice is available' : 'Finish local voice setup'}
        description="These components work together. You do not need to choose a different model for each conversation."
      >
        <Button
          variant="primary"
          busy={busy.has('settings.update')}
          isDisabled={!canUseLocal || snapshot.settings.conversationEngine === 'pipeline'}
          onPress={() => {
            void command({
              type: 'settings.update',
              patch: { conversationEngine: 'pipeline', replyLength: 'brief', speakReplies: true },
            })
          }}
        >
          {snapshot.settings.conversationEngine === 'pipeline'
            ? 'Selected'
            : 'Use local conversation'}
        </Button>
      </Row>
      <Group
        title="Standard voice components"
        detail="Hearing, replies, speech, turn endings and your wake name."
      >
        {standard.map((model) => (
          <ModelRow key={model.id} model={model} runtime={runtime} working={working} />
        ))}
      </Group>
      <Button
        variant="ghost"
        aria-expanded={showMore}
        aria-controls="optional-models"
        onPress={() => setShowMore(!showMore)}
      >
        {showMore ? 'Hide optional models' : 'Show optional and experimental models'}
      </Button>
      <div id="optional-models" hidden={!showMore}>
        <Group
          title="Optional capabilities"
          detail="Memory search, alternative recognition and experimental models. These are not required for the standard voice setup."
        >
          {optional.map((model) => (
            <ModelRow key={model.id} model={model} runtime={runtime} working={working} />
          ))}
        </Group>
      </div>
      <p className="fine-print">
        Models run in a separate process without provider credentials. Large inference jobs run one
        at a time to leave room for the rest of your Mac.
      </p>
    </>
  )
}
