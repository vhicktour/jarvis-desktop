import type { VoicePhase } from './contracts'

/**
 * When a spoken turn ends, and whether the microphone opens again after the reply.
 *
 * The service worker owns the audio; these are the rules it applies to what it hears,
 * kept apart from it so they can be observed without a microphone.
 */

/** The models a turn ending is judged by, in the order Settings names them. */
export const ENDPOINT_MODELS = ['silero', 'smart-turn'] as const
/** The model that hears whether somebody is speaking, frame by frame. */
export const VOICE_MODEL = 'silero'
/** The model that hears whether what was said sounds finished. */
export const TURN_MODEL = 'smart-turn'
/**
 * Level, 0 to 1, loud enough to be somebody speaking rather than the room. Only a fallback: the
 * voice model decides while it is running, and the level is read when it is not installed.
 */
export const SPEECH_LEVEL = 0.035
/**
 * Silence after speech before the turn model is first asked whether the thought is finished.
 * People leave about a quarter of a second between turns; waiting much longer reads as slow.
 */
export const ENDPOINT_PAUSE_SECONDS = 0.25
/** While the pause continues, how often the turn model is asked again. */
export const ENDPOINT_RETRY_SECONDS = 0.4
/**
 * Silence after speech that ends a turn on its own, whatever the turn model thinks — or when
 * there is no turn model. A finished sentence usually ends sooner; a trailing thought waits this.
 */
export const ENDPOINT_SILENCE_SECONDS = 1.5
/** The longest single recording, whether or not anything was said into it. */
export const TURN_LIMIT_SECONDS = 120
/** How long a hands-free microphone waits for a person who says nothing at all. */
export const HANDS_FREE_PATIENCE_SECONDS = 10
/** Playback tail left to settle before the microphone opens again, in milliseconds. */
export const HANDS_FREE_SETTLE_MS = 400
/**
 * Silence that ends a turn nobody asked to open, when no model is judging the end of a thought.
 * A microphone the wake word opened cannot be left for the person to close by hand — they did
 * not open it by hand.
 */
export const UNATTENDED_SILENCE_SECONDS = 2

export type ListeningTurn = {
  /** Seconds recorded so far. */
  elapsed: number
  /** Whether the voice model hears somebody speaking right now. */
  speaking: boolean
  /** Elapsed when speech last stopped; zero while nothing has been said. */
  lastSpeechAt: number
  /** Elapsed at the last endpoint examination; zero before the first. */
  lastEndpointAt: number
  /** Whether automatic endpointing is switched on. */
  endpointing: boolean
  /** Whether the turn model may be asked, which needs it to have passed its check here. */
  semantic: boolean
  /** Whether this turn belongs to a hands-free session. */
  handsFree: boolean
  /** Whether the turn was opened by something other than the person, so silence must close it. */
  unattended?: boolean
}
export type TurnAction =
  /** Keep recording. */
  | 'wait'
  /** Ask the turn model whether the thought is finished. */
  | 'examine'
  /** Close the microphone and transcribe what was said. */
  | 'finish'
  /** Close the microphone and discard the recording; nobody spoke into it. */
  | 'abandon'

/** What an open microphone should do next, from what it has heard so far. */
export function turnAction(turn: ListeningTurn): TurnAction {
  if (turn.elapsed >= TURN_LIMIT_SECONDS) return 'finish'
  // A microphone that opened without being asked has to close the same way.
  if (
    (turn.handsFree || turn.unattended) &&
    !turn.speaking &&
    turn.lastSpeechAt === 0 &&
    turn.elapsed >= HANDS_FREE_PATIENCE_SECONDS
  )
    return 'abandon'
  if (turn.speaking || turn.lastSpeechAt === 0) return 'wait'
  const silence = turn.elapsed - turn.lastSpeechAt
  if (turn.endpointing) {
    // Silence alone settles it in the end; the turn model only lets a finished thought end sooner.
    if (silence >= ENDPOINT_SILENCE_SECONDS) return 'finish'
    if (
      turn.semantic &&
      silence >= ENDPOINT_PAUSE_SECONDS &&
      turn.elapsed - turn.lastEndpointAt >= ENDPOINT_RETRY_SECONDS
    )
      return 'examine'
    return 'wait'
  }
  // Opened by the wake word with no endpointing: silence after speech is still enough to stop a
  // microphone nobody opened, only later, because nothing is judging whether the thought ended.
  if (turn.unattended && silence >= UNATTENDED_SILENCE_SECONDS) return 'finish'
  return 'wait'
}

/** Endpointing needs the voice model to have passed its check on this Mac; silence is the rest. */
export function endpointingReady(qualified: (id: string) => boolean) {
  return qualified(VOICE_MODEL)
}
/** Finishing a turn early, on meaning rather than silence, needs the turn model as well. */
export function semanticReady(qualified: (id: string) => boolean) {
  return qualified(TURN_MODEL)
}
/** Nothing else closes the microphone, so hands-free cannot stand without endpointing. */
export function handsFreeReady(
  settings: { automaticEndpointing: boolean },
  qualified: (id: string) => boolean,
) {
  return settings.automaticEndpointing && endpointingReady(qualified)
}
/** Hands-free cannot outlive the endpointing it rests on, so one write settles both. */
export function withVoiceDependencies<
  T extends { automaticEndpointing: boolean; handsFree: boolean },
>(settings: T): T {
  return settings.automaticEndpointing ? settings : { ...settings, handsFree: false }
}

/** The model that decides whether the person said the name. */
export const WAKE_MODEL = 'openwakeword'
export const KEYWORD_MODEL = 'keyword'
/**
 * Silence costs nothing: the wake model is only asked about audio the voice model already
 * says is speech, so an empty room never reaches it.
 */
export const WAKE_SCORE_INTERVAL_MS = 400
/** How long the room has to stay quiet before the wake listener stops scoring again. */
export const WAKE_QUIET_SECONDS = 1.5
/**
 * Speech during a reply, in seconds, before it is taken as an interruption rather than a
 * word thrown at the room. Echo cancellation is imperfect, so one stray frame is not enough.
 */
export const BARGE_IN_SECONDS = 0.4
/** Playback level the microphone has to beat before it is believed over the speaker. */
export const BARGE_IN_MARGIN = 0.5
/** Playback start is the worst moment for residual echo, so it is not listened through. */
export const BARGE_IN_SETTLE_SECONDS = 0.25

/**
 * The wake model is trained on the two-word phrase and scores a bare "Jarvis" at the floor,
 * so the name on its own is heard a second way: a burst of speech short enough to be one
 * word is transcribed and read. Anything longer than a name is never transcribed at all.
 */
export const NAME_MODELS = ['parakeet', 'whisper'] as const
/** Shorter than this is not a word. */
export const NAME_MIN_SECONDS = 0.25
/** Longer than this is a sentence, and a sentence is somebody's conversation. */
export const NAME_MAX_SECONDS = 1.2
/** Quiet needed after a burst before it counts as finished rather than paused. */
export const NAME_GAP_SECONDS = 0.35
/**
 * Anchored at both ends: a clip holding the name and nothing else. A request that opens
 * with the name is a sentence, which never reaches here — it is too long to be transcribed.
 */
/** Whether a transcript of a short burst is the name being called. */
export function isNameSpoken(text: string, name = 'Jarvis') {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^(?:hey[,\\s]+)?${escaped}\\b[\\s.,!?…]*$`, 'i').test(text.trim())
}
/** Hearing the bare name needs something that can transcribe one word. */
export function nameWakeReady(qualified: (id: string) => boolean) {
  return NAME_MODELS.some((id) => qualified(id))
}

export type SpokenBurst = {
  /** Length of the burst of speech that just ended, in seconds. */
  burstSeconds: number
  /** Seconds of quiet since the burst ended. */
  quietSeconds: number
  /** Whether a transcription is already running. */
  busy: boolean
}
/**
 * Whether a burst that just ended is worth transcribing to see if it was the name. The
 * length gate is the privacy boundary, not an optimisation: a burst outside it is never
 * sent to recognition, so ordinary talk in the room is never transcribed.
 */
export function shouldTranscribeForName(burst: SpokenBurst) {
  if (burst.busy || burst.quietSeconds < NAME_GAP_SECONDS) return false
  return burst.burstSeconds >= NAME_MIN_SECONDS && burst.burstSeconds <= NAME_MAX_SECONDS
}

/** Waking is offered only where the wake model has passed its check on this Mac. */
export function wakeReady(qualified: (id: string) => boolean, name = 'Jarvis') {
  return (
    (qualified(KEYWORD_MODEL) && qualified(VOICE_MODEL)) ||
    (name.toLowerCase() === 'jarvis' && qualified(WAKE_MODEL))
  )
}
/** Interrupting needs a voice to hear over the speaker, and a model that hears it. */
export function bargeInReady(qualified: (id: string) => boolean) {
  return qualified(VOICE_MODEL)
}
/**
 * Waking, interrupting and endpointing each rest on their own qualified model, so a setting
 * that lost its model is cleared rather than left switched on over nothing.
 */
export function withListeningDependencies<
  T extends {
    wakeWord: boolean
    wakeOnName: boolean
    wakeName?: string
    bargeIn: boolean
    automaticEndpointing: boolean
    handsFree: boolean
  },
>(settings: T, qualified: (id: string) => boolean): T {
  const settled = withVoiceDependencies({
    ...settings,
    automaticEndpointing: settings.automaticEndpointing && endpointingReady(qualified),
  })
  const wakeWord = settled.wakeWord && wakeReady(qualified, settled.wakeName)
  return {
    ...settled,
    wakeWord,
    // Nothing holds the microphone open for the bare name on its own, so it follows the phrase.
    wakeOnName: wakeWord && settled.wakeOnName && nameWakeReady(qualified),
    bargeIn: settled.bargeIn && bargeInReady(qualified),
  }
}

export type WakeWatch = {
  /** Whether the person has switched waking on. */
  wakeWord: boolean
  phase: VoicePhase
  locked: boolean
  closing: boolean
  /** Whether the reply being spoken may be interrupted. */
  bargeIn: boolean
  responding?: boolean
}
/**
 * Whether the microphone should be held open listening for the name. It is never held open
 * behind a turn the person already started; only an idle Jarvis listens, and a speaking one
 * only when it has been told its reply may be interrupted.
 */
export function shouldWatchForWake(watch: WakeWatch) {
  if (watch.locked || watch.closing) return false
  if (watch.phase === 'speaking' || watch.responding) return watch.bargeIn
  return watch.wakeWord && (watch.phase === 'off' || watch.phase === 'error')
}

export type WakeScoring = {
  /** Whether somebody is speaking right now. */
  speaking: boolean
  /** Seconds since speech last stopped; zero while somebody is talking. */
  quietSeconds: number
  /** Milliseconds since the wake model was last asked. */
  sinceScoredMs: number
}
/**
 * Whether to ask the wake model about what the microphone is holding. An idle room never
 * reaches the model: scoring starts when somebody is talking and continues briefly after
 * they stop, so a name finishing in silence is still inside the buffer.
 */
export function shouldScoreWake(scoring: WakeScoring) {
  if (scoring.sinceScoredMs < WAKE_SCORE_INTERVAL_MS) return false
  return scoring.speaking || scoring.quietSeconds < WAKE_QUIET_SECONDS
}

export type PlaybackListen = {
  /** Seconds of unbroken speech the voice model has heard since the reply started playing. */
  speechSeconds: number
  /** Seconds the reply has been playing. */
  elapsed: number
  /** Microphone level, 0 to 1. */
  level: number
  /** The level the reply itself is playing at, 0 to 1. */
  playbackLevel: number
}
/**
 * Whether speech heard during a reply is the person interrupting. Residual echo rises and
 * falls with the reply, so the bar rises with it too, and it has to be held rather than
 * touched — a single frame over the line is the shape echo takes, not the shape of a sentence.
 */
export function isInterruption(listen: PlaybackListen) {
  if (listen.elapsed < BARGE_IN_SETTLE_SECONDS) return false
  if (listen.level < SPEECH_LEVEL) return false
  if (listen.level < listen.playbackLevel * BARGE_IN_MARGIN) return false
  return listen.speechSeconds >= BARGE_IN_SECONDS
}

export type ResumeContext = {
  /** Whether a hands-free session is still running. */
  handsFree: boolean
  phase: VoicePhase
  locked: boolean
  closing: boolean
  automaticEndpointing: boolean
  qualified: (id: string) => boolean
}
/** Whether a finished reply should open the microphone again for the next thought. */
export function shouldReopenMicrophone(context: ResumeContext) {
  return (
    context.handsFree &&
    context.phase === 'off' &&
    !context.locked &&
    !context.closing &&
    handsFreeReady(context, context.qualified)
  )
}
