import { Headphones, Mic, Volume2 } from 'lucide-react'
import { useJarvis } from '../state'
import { Core } from '../Orb'
import { Button, Group, Row, Toggle } from '../ui'

export function Voice() {
  const { snapshot, command, busy } = useJarvis()
  const granted = snapshot.permissions.microphone === 'granted'
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
        <p className="metadata">
          {snapshot.voice.phase === 'listening'
            ? 'LISTENING · CLICK THE ORB TO FINISH'
            : snapshot.voice.phase === 'speaking'
              ? 'SPEECH PLAYBACK · CLICK THE ORB TO INTERRUPT'
              : 'MICROPHONE IDLE'}
        </p>
        <Toggle
          label="Finish a turn naturally"
          description="Experimental: Silero and Smart Turn check a pause after you activate the microphone. Click the orb to finish at any time."
          selected={snapshot.settings.automaticEndpointing}
          onChange={(automaticEndpointing) => {
            void command({ type: 'settings.update', patch: { automaticEndpointing } })
          }}
        />
        <Toggle
          label="Hands-free conversation"
          description="Continue listening after a response. Requires qualified voice endpointing."
          selected={snapshot.settings.handsFree}
          onChange={(handsFree) => {
            void command({ type: 'settings.update', patch: { handsFree } })
          }}
        />
      </Group>
    </>
  )
}
