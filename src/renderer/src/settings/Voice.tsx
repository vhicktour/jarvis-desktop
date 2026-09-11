import { Headphones, Mic, Volume2 } from 'lucide-react'
import { ENDPOINT_MODELS } from '../../../shared/turn'
import { DUPLEX_MODEL, type ConversationEngine } from '../../../shared/speech'
import { useJarvis } from '../state'
import { Core } from '../Orb'
import { Button, Group, Row, Toggle } from '../ui'

/** What the microphone is doing, in the words the orb uses for the same states. */
function microphoneStatus(voice: { phase: string; handsFree: boolean }) {
  if (voice.phase === 'listening')
    return voice.handsFree
      ? 'HANDS-FREE · LISTENING · CLICK THE ORB TO FINISH'
      : 'LISTENING · CLICK THE ORB TO FINISH'
  if (voice.phase === 'speaking') return 'SPEECH PLAYBACK · CLICK THE ORB TO INTERRUPT'
  if (voice.handsFree) return 'HANDS-FREE · THE MICROPHONE OPENS AGAIN AFTER THIS REPLY'
  return 'MICROPHONE IDLE'
}

export function Voice() {
  const { snapshot, command, busy } = useJarvis()
  const granted = snapshot.permissions.microphone === 'granted'
  const unqualified = ENDPOINT_MODELS.filter(
    (id) => !snapshot.models.some((model) => model.id === id && model.qualified),
  ).map((id) => snapshot.models.find((model) => model.id === id)?.name ?? id)
  const endpointing = snapshot.settings.automaticEndpointing
  const duplex = snapshot.models.find((model) => model.id === DUPLEX_MODEL)
  const realtime = snapshot.connections.find((c) => c.id === 'openai-realtime')
  const engine = snapshot.settings.conversationEngine
  const engines: {
    id: ConversationEngine
    name: string
    detail: string
    ready: boolean
    blocked: string
  }[] = [
    {
      id: 'pipeline',
      name: 'Separate models',
      detail: 'Hears you, thinks, then speaks. Always available.',
      ready: true,
      blocked: '',
    },
    {
      id: 'duplex',
      name: 'One voice model',
      detail: `${duplex?.name ?? 'A speech-to-speech model'} answers your voice directly, without transcribing it first.`,
      ready: !!duplex?.qualified,
      blocked: duplex
        ? `${duplex.name} has not passed its checks on this Mac yet.`
        : 'No speech-to-speech model is installed.',
    },
    {
      id: 'realtime',
      name: 'OpenAI Realtime',
      detail: 'The fastest and the only one that sends your voice off this Mac.',
      ready: realtime?.status === 'connected',
      blocked: 'Connect OpenAI Realtime in Connections first.',
    },
  ]
  return (
    <>
      <div className="voice-card">
        <div className="voice-portrait">
          <Core showcase />
        </div>
        <div>
          <span className="eyebrow">THE VOICE OF JARVIS</span>
          <h2>George</h2>
          <p>British · composed · quietly capable</p>
          <Button
            onPress={() => {
              void command({ type: 'voice.audition' })
            }}
            busy={busy.has('voice.audition')}
          >
            <Volume2 size={14} />
            Hear a little introduction
          </Button>
        </div>
        <span className="voice-signature">bm_george</span>
      </div>
      {!snapshot.models.find((m) => m.id === 'kokoro' && m.status === 'installed') && (
        <div className="inline-note">
          <Headphones size={16} />
          <p>Install Kokoro for George’s voice. macOS speech is available as a recovery voice.</p>
        </div>
      )}
      <Group title="A natural rhythm">
        <Row title="Speaking pace" description="Give each thought a little more room.">
          <div className="range-control">
            <input
              aria-label="Speaking pace"
              type="range"
              min="0.7"
              max="1.4"
              step="0.05"
              value={snapshot.settings.voiceSpeed}
              onChange={(event) => {
                void command({
                  type: 'settings.update',
                  patch: { voiceSpeed: Number(event.target.value) },
                })
              }}
            />
            <span>{snapshot.settings.voiceSpeed.toFixed(2)}×</span>
          </div>
        </Row>
        <Toggle
          label="Spoken responses"
          description="Click the orb during speech to interrupt immediately."
          selected={snapshot.settings.speakReplies}
          onChange={(speakReplies) => {
            void command({ type: 'settings.update', patch: { speakReplies } })
          }}
        />
      </Group>
      <Group title="How a reply is made">
        {engines.map((option) => (
          <Row
            key={option.id}
            title={option.name}
            description={option.ready ? option.detail : option.blocked}
          >
            <Button
              variant={engine === option.id ? 'primary' : 'secondary'}
              busy={busy.has('settings.update')}
              isDisabled={!option.ready || engine === option.id}
              onPress={() => {
                void command({
                  type: 'settings.update',
                  patch: { conversationEngine: option.id },
                })
              }}
            >
              {engine === option.id ? 'In use' : option.ready ? 'Use this' : 'Unavailable'}
            </Button>
          </Row>
        ))}
      </Group>
      <Group title="Your microphone">
        <Row
          title={granted ? 'Microphone connected' : 'Let Jarvis hear you'}
          description={
            granted
              ? 'Raw audio is temporary and stays on this Mac.'
              : 'Microphone access is requested only when you enable it.'
          }
        >
          <Button
            onPress={() => {
              void command({
                type: granted ? 'voice.toggle' : 'permission.request',
                ...(granted ? {} : { permission: 'microphone' }),
              } as any)
            }}
          >
            <Mic size={14} />
            {granted
              ? snapshot.voice.phase === 'listening'
                ? 'Finish recording'
                : 'Test microphone'
              : 'Allow microphone'}
          </Button>
        </Row>
        <div
          className="level-meter"
          aria-label={`${snapshot.voice.phase === 'speaking' ? 'Speech' : 'Microphone'} level ${Math.round(snapshot.voice.level * 100)} percent`}
        >
          {Array.from({ length: 48 }, (_, index) => (
            <span key={index} className={index / 48 < snapshot.voice.level ? 'lit' : ''} />
          ))}
        </div>
        <p className="metadata">{microphoneStatus(snapshot.voice)}</p>
        <Toggle
          label="Finish a turn naturally"
          description={
            unqualified.length
              ? `${unqualified.join(' and ')} ${unqualified.length > 1 ? 'need' : 'needs'} to pass ${unqualified.length > 1 ? 'their checks' : 'its check'} in Local models before Jarvis can finish a turn for you.`
              : 'Experimental: Silero and Smart Turn check a pause after you activate the microphone. Click the orb to finish at any time.'
          }
          isDisabled={!!unqualified.length}
          selected={endpointing}
          onChange={(automaticEndpointing) => {
            void command({ type: 'settings.update', patch: { automaticEndpointing } })
          }}
        />
        <Toggle
          label="Hands-free conversation"
          description={
            endpointing
              ? 'The microphone opens again after each reply, and closes on its own if you say nothing. Click the orb while Jarvis speaks to stop.'
              : 'Continue listening after a response. Requires qualified voice endpointing.'
          }
          isDisabled={!endpointing}
          selected={snapshot.settings.handsFree}
          onChange={(handsFree) => {
            void command({ type: 'settings.update', patch: { handsFree } })
          }}
        />
      </Group>
    </>
  )
}
