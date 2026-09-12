import { Headphones, Mic, Volume2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Settings, type VoiceStatus } from '../../../shared/contracts'
import { DUPLEX_MODEL, engineReady, type ConversationEngine } from '../../../shared/speech'
import {
  KEYWORD_MODEL,
  TURN_MODEL,
  VOICE_MODEL,
  wakeReady,
  nameWakeReady,
} from '../../../shared/turn'
import { useJarvis } from '../state'
import { Core } from '../Orb'
import { Button, Group, Row, Toggle } from '../ui'

/** What the microphone is doing, in the words the orb uses for the same states. */
function microphoneStatus(voice: VoiceStatus, endpointing: boolean, continuous = false) {
  if (voice.phase === 'listening') {
    const finish = endpointing ? 'FINISHES WHEN YOU STOP' : 'CLICK THE ORB TO FINISH'
    return voice.handsFree ? `HANDS-FREE · LISTENING · ${finish}` : `LISTENING · ${finish}`
  }
  if (voice.phase === 'speaking') return 'SPEECH PLAYBACK · CLICK THE ORB TO INTERRUPT'
  if (voice.handsFree)
    return continuous
      ? 'LIVE CONVERSATION · THE MICROPHONE STAYS OPEN'
      : 'HANDS-FREE · THE MICROPHONE OPENS AGAIN AFTER THIS REPLY'
  if (voice.watching) {
    if (voice.listener?.state === 'ready')
      return voice.listener.detector === 'vad'
        ? 'LISTENING FOR SPEECH'
        : 'LISTENING FOR YOUR NAME · AUDIO IS STAYING ON THIS MAC'
    if (voice.listener?.state === 'error' || voice.listener?.state === 'stalled')
      return 'WAKE LISTENER NEEDS ATTENTION · RUN A WAKE CHECK'
    return 'STARTING THE WAKE LISTENER'
  }
  return 'MICROPHONE IDLE'
}

export function Voice() {
  const { snapshot, command, busy } = useJarvis()
  const [name, setName] = useState(snapshot.settings.wakeName)
  useEffect(() => setName(snapshot.settings.wakeName), [snapshot.settings.wakeName])
  const granted = snapshot.permissions.microphone === 'granted'
  const qualified = (id: string) =>
    snapshot.diagnostics.modelRuntime &&
    snapshot.models.some(
      (model) => model.id === id && model.status === 'installed' && model.qualified,
    )
  const voiceModel = snapshot.models.find((model) => model.id === VOICE_MODEL)
  const turnModel = snapshot.models.find((model) => model.id === TURN_MODEL)
  const canEndpoint = qualified(VOICE_MODEL)
  const semantic = qualified(TURN_MODEL)
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
      name: 'Local conversation',
      detail:
        'Recommended local setup. Speech recognition, replies and speech work together on your Mac.',
      ready: engineReady('pipeline', qualified, () => false),
      blocked:
        'Start the local runtime and check Whisper and Qwen in Local models to enable conversation.',
    },
    {
      id: 'duplex',
      name: 'LFM Audio · experimental',
      detail: `${duplex?.name ?? 'A speech-to-speech model'} answers from audio. A short local transcript also routes tasks and memory requests.`,
      ready: engineReady('duplex', qualified, () => false),
      blocked: duplex
        ? `Check ${duplex.name} and a speech recognition model in Local models first.`
        : 'No speech-to-speech model is installed.',
    },
    {
      id: 'realtime',
      name: 'OpenAI Realtime',
      detail:
        'Live audio, semantic turn detection and interruption. Voice and conversation context are sent to OpenAI; usage is paid.',
      ready:
        realtime?.status === 'connected' &&
        snapshot.settings.privacyMode !== 'local-only' &&
        snapshot.settings.budget.maxCostUsd !== null,
      blocked:
        'Connect OpenAI, set a usage ceiling in Connections, and use Local-first privacy mode.',
    },
  ]
  const wakeName = snapshot.settings.wakeName
  const customWake = qualified(KEYWORD_MODEL)
  const canWake = wakeReady(qualified, wakeName)
  const canHearName = nameWakeReady(qualified)
  const canInterrupt = qualified('silero')
  const natural =
    snapshot.settings.automaticEndpointing &&
    snapshot.settings.handsFree &&
    snapshot.settings.wakeWord &&
    snapshot.settings.wakeOnName &&
    snapshot.settings.bargeIn
  return (
    <>
      <div className="voice-card">
        <div className="voice-portrait">
          <Core showcase />
        </div>
        <div>
          <span className="eyebrow">THE VOICE OF JARVIS</span>
          <h2>{engine === 'realtime' ? 'Cedar' : engine === 'duplex' ? 'LFM Audio' : 'George'}</h2>
          <p>
            {engine === 'pipeline'
              ? 'British · composed · quietly capable'
              : 'A concise voice conversation'}
          </p>
          <Button
            onPress={() => {
              void command({ type: engine === 'pipeline' ? 'voice.audition' : 'voice.toggle' })
            }}
            busy={busy.has('voice.audition')}
          >
            <Volume2 size={14} />
            {engine === 'pipeline' ? 'Hear a little introduction' : 'Start a voice check'}
          </Button>
        </div>
        <span className="voice-signature">
          {engine === 'pipeline' ? 'bm_george' : engine === 'realtime' ? 'OpenAI' : 'Local audio'}
        </span>
      </div>
      {!snapshot.models.find((m) => m.id === 'kokoro' && m.status === 'installed') && (
        <div className="inline-note">
          <Headphones size={16} />
          <p>Install Kokoro for George’s voice. macOS speech is available as a recovery voice.</p>
        </div>
      )}
      <Group title="A natural rhythm">
        <Row
          title={`Ready when you say “Hey ${wakeName}”`}
          description="Enable wake word, automatic turn endings, hands-free follow-up, interruption and brief answers together."
        >
          <Button
            variant="primary"
            isDisabled={natural || !canWake || !canEndpoint || !canHearName}
            busy={busy.has('settings.update')}
            onPress={async () => {
              const permissions = granted
                ? snapshot.permissions
                : await command({ type: 'permission.request', permission: 'microphone' })
              if (permissions?.microphone === 'granted')
                await command({
                  type: 'settings.update',
                  patch: {
                    automaticEndpointing: true,
                    handsFree: true,
                    wakeWord: true,
                    wakeOnName: true,
                    bargeIn: true,
                    replyLength: 'brief',
                    speakReplies: true,
                  },
                })
            }}
          >
            {natural ? 'Enabled' : 'Enable natural conversation'}
          </Button>
        </Row>
        <Row title="Speaking pace" description="Give each thought a little more room.">
          <div className="range-control">
            <input
              aria-label="Speaking pace"
              type="range"
              min="0.7"
              max="1.4"
              step="0.05"
              disabled={engine !== 'pipeline'}
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
              ? engine === 'realtime'
                ? 'Active voice audio is streamed to OpenAI. Wake word detection stays on this Mac.'
                : 'Raw audio is temporary and stays on this Mac.'
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
          role="meter"
          aria-label={`${snapshot.voice.phase === 'speaking' ? 'Speech' : 'Microphone'} level`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(snapshot.voice.level * 100)}
        >
          {Array.from({ length: 48 }, (_, index) => (
            <span key={index} className={index / 48 < snapshot.voice.level ? 'lit' : ''} />
          ))}
        </div>
        <p className="metadata">
          {microphoneStatus(
            snapshot.voice,
            engine === 'realtime' || endpointing,
            engine === 'realtime',
          )}
        </p>
        <Toggle
          label="Finish a turn naturally"
          description={
            engine === 'realtime'
              ? 'OpenAI semantic turn detection ends your turn automatically. Click the orb to finish sooner.'
              : !canEndpoint
                ? `${voiceModel?.name ?? 'Silero VAD'} needs to pass its check in Local models before Jarvis can hear the end of a turn.`
                : semantic
                  ? `${voiceModel?.name ?? 'Silero VAD'} hears you stop and ${turnModel?.name ?? 'Smart Turn'} hears whether the thought is finished, so a question ends the turn about a quarter of a second after you stop. Click the orb to finish at any time.`
                  : `${voiceModel?.name ?? 'Silero VAD'} hears you stop and ends the turn after a second and a half of quiet. Check ${turnModel?.name ?? 'Smart Turn'} in Local models and a finished thought ends it sooner.`
          }
          isDisabled={engine === 'realtime' || !canEndpoint}
          selected={engine === 'realtime' || endpointing}
          onChange={(automaticEndpointing) => {
            void command({ type: 'settings.update', patch: { automaticEndpointing } })
          }}
        />
        <Toggle
          label="Hands-free conversation"
          description={
            engine === 'realtime'
              ? 'The microphone stays open during a live conversation. The session closes after you stop talking; click the orb during a reply to end it.'
              : endpointing
                ? 'The microphone opens again after each reply, and closes on its own if you say nothing. Click the orb while Jarvis speaks to stop.'
                : 'Continue listening after a response. Requires qualified voice endpointing.'
          }
          isDisabled={engine === 'realtime' || !endpointing}
          selected={engine === 'realtime' || snapshot.settings.handsFree}
          onChange={(handsFree) => {
            void command({ type: 'settings.update', patch: { handsFree } })
          }}
        />
      </Group>
      <Group
        title="Wake name"
        detail="The microphone stays open to hear it. Short name candidates are checked locally and discarded."
      >
        <Row
          title="What you call your assistant"
          description={
            customWake
              ? 'Choose 2–32 English letters, up to three words. A distinct name is easier to recognize.'
              : 'Install and check Custom Wake Name in Local models to choose another name.'
          }
        >
          <div className="shortcut-editor">
            <input
              aria-label="Wake name"
              value={name}
              maxLength={32}
              disabled={!customWake}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              isDisabled={
                !customWake ||
                name.trim() === wakeName ||
                !Settings.shape.wakeName.safeParse(name).success
              }
              busy={busy.has('settings.update')}
              onPress={() => {
                void command({ type: 'settings.update', patch: { wakeName: name.trim() } })
              }}
            >
              Save
            </Button>
          </div>
        </Row>
        <Toggle
          label={`Answer to “Hey ${wakeName}”`}
          description={
            canWake
              ? 'The microphone listens for the phrase and nothing else. It never transcribes what it hears.'
              : 'Install and check Custom Wake Name in Local models before Jarvis can hear its name.'
          }
          isDisabled={!canWake}
          selected={snapshot.settings.wakeWord}
          onChange={(wakeWord) => {
            void command({ type: 'settings.update', patch: { wakeWord } })
          }}
        />
        <Toggle
          label={`Answer to “${wakeName}” on its own`}
          description={
            !snapshot.settings.wakeWord
              ? `Switch on “Hey ${wakeName}” first; the bare name uses the same microphone.`
              : canHearName
                ? customWake
                  ? 'A keyword candidate is confirmed in a short local audio check, so similar-sounding words do not open a conversation.'
                  : 'A short burst is transcribed locally to check the name. Install Custom Wake Name for streaming recognition.'
                : 'Install and check Whisper in Local models to confirm the bare name.'
          }
          isDisabled={!snapshot.settings.wakeWord || !canHearName}
          selected={snapshot.settings.wakeOnName}
          onChange={(wakeOnName) => {
            void command({ type: 'settings.update', patch: { wakeOnName } })
          }}
        />
        <Row
          title="Check the wake name"
          description={
            snapshot.voice.wakeTest?.message ??
            `Say “Hey ${wakeName}” after starting the check. This tests your microphone and does not open a cloud conversation.`
          }
        >
          <Button
            isDisabled={
              !snapshot.settings.wakeWord ||
              !granted ||
              !['off', 'error'].includes(snapshot.voice.phase)
            }
            busy={snapshot.voice.wakeTest?.state === 'listening' || busy.has('voice.testWake')}
            onPress={() => {
              void command({ type: 'voice.testWake' })
            }}
          >
            Test wake name
          </Button>
        </Row>
        <Toggle
          label="Let me interrupt"
          description={
            engine === 'realtime'
              ? 'Speak over a reply to stop playback and take the next turn. OpenAI detects speech; this Mac cancels playback echo.'
              : canInterrupt
                ? 'Speak over a reply to stop it. Needs echo cancellation on this audio route, or Jarvis would interrupt itself.'
                : 'Install and check Silero VAD in Local models before Jarvis can tell you from itself.'
          }
          isDisabled={engine === 'realtime' || !canInterrupt}
          selected={engine === 'realtime' || snapshot.settings.bargeIn}
          onChange={(bargeIn) => {
            void command({ type: 'settings.update', patch: { bargeIn } })
          }}
        />
      </Group>
    </>
  )
}
