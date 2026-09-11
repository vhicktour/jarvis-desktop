import type { VoicePhase } from './contracts'

/**
 * When a spoken turn ends, and whether the microphone opens again after the reply.
 *
 * The service worker owns the audio; these are the rules it applies to what it hears,
 * kept apart from it so they can be observed without a microphone.
 */

/** The models a turn ending is judged by, in the order Settings names them. */
export const ENDPOINT_MODELS = ['silero', 'smart-turn'] as const
/** Level, 0 to 1, loud enough to be somebody speaking rather than the room. */
export const SPEECH_LEVEL = 0.035
/** Silence after speech before the endpoint models are asked whether the thought is finished. */
export const ENDPOINT_PAUSE_SECONDS = 1.2
/** The longest single recording, whether or not anything was said into it. */
export const TURN_LIMIT_SECONDS = 120
/** How long a hands-free microphone waits for a person who says nothing at all. */
export const HANDS_FREE_PATIENCE_SECONDS = 10
/** Playback tail left to settle before the microphone opens again, in milliseconds. */
export const HANDS_FREE_SETTLE_MS = 400

export type ListeningTurn = {
  /** Seconds recorded so far. */
  elapsed: number
  /** Elapsed at the last sample above SPEECH_LEVEL; zero while nothing has been said. */
  lastSpeechAt: number
  /** Elapsed at the last endpoint examination; zero before the first. */
  lastEndpointAt: number
  /** Whether automatic endpointing is switched on. */
  endpointing: boolean
  /** Whether this turn belongs to a hands-free session. */
  handsFree: boolean
}
export type TurnAction =
  /** Keep recording. */
  | 'wait'
  /** Ask the endpoint models whether the thought is finished. */
  | 'examine'
  /** Close the microphone and transcribe what was said. */
  | 'finish'
  /** Close the microphone and discard the recording; nobody spoke into it. */
  | 'abandon'

/** What an open microphone should do next, from what it has heard so far. */
export function turnAction(turn: ListeningTurn): TurnAction {
  if (turn.elapsed >= TURN_LIMIT_SECONDS) return 'finish'
  // A hands-free microphone opens without being asked, so it has to close the same way.
  if (turn.handsFree && turn.lastSpeechAt === 0 && turn.elapsed >= HANDS_FREE_PATIENCE_SECONDS)
    return 'abandon'
  if (
    turn.endpointing &&
    turn.lastSpeechAt > 0 &&
    turn.elapsed - turn.lastSpeechAt >= ENDPOINT_PAUSE_SECONDS &&
    turn.elapsed - turn.lastEndpointAt >= ENDPOINT_PAUSE_SECONDS
  )
    return 'examine'
  return 'wait'
}

/** Endpointing is offered only where both models have passed their checks on this Mac. */
export function endpointingReady(qualified: (id: string) => boolean) {
  return ENDPOINT_MODELS.every((id) => qualified(id))
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
/**
 * Silence costs nothing: the wake model is only asked about audio the level meter already
 * says is speech, so an empty room never reaches it.
 */
export const WAKE_SCORE_INTERVAL_MS = 400
/** How long the level has to stay quiet before the wake listener stops scoring again. */
export const WAKE_QUIET_SECONDS = 1.5
/**
 * Speech during a reply, in seconds, before it is taken as an interruption rather than a
 * word thrown at the room. Echo cancellation is imperfect, so one stray frame is not enough.
 */
export const BARGE_IN_SECONDS = 0.35
/** Playback level the microphone has to beat before it is believed over the speaker. */
export const BARGE_IN_MARGIN = 0.5
/** Playback start is the worst moment for residual echo, so it is not listened through. */
export const BARGE_IN_SETTLE_SECONDS = 0.25

/** Waking is offered only where the wake model has passed its check on this Mac. */
export function wakeReady(qualified: (id: string) => boolean) {
  return qualified(WAKE_MODEL)
}
/** Interrupting needs a voice to hear over the speaker, and a model that hears it. */
export function bargeInReady(qualified: (id: string) => boolean) {
  return qualified('silero')
}
/**
 * Waking and interrupting each rest on their own qualified model, so a setting that lost
 * its model is cleared rather than left switched on over nothing.
 */
export function withListeningDependencies<
  T extends {
    wakeWord: boolean
    bargeIn: boolean
    automaticEndpointing: boolean
    handsFree: boolean
  },
>(settings: T, qualified: (id: string) => boolean): T {
  const settled = withVoiceDependencies(settings)
  return {
    ...settled,
    wakeWord: settled.wakeWord && wakeReady(qualified),
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
}
/**
 * Whether the microphone should be held open listening for the name. It is never held open
 * behind a turn the person already started; only an idle Jarvis listens, and a speaking one
 * only when it has been told its reply may be interrupted.
 */
export function shouldWatchForWake(watch: WakeWatch) {
  if (watch.locked || watch.closing) return false
  if (watch.phase === 'speaking') return watch.bargeIn
  return watch.wakeWord && (watch.phase === 'off' || watch.phase === 'error')
}

export type WakeScoring = {
  /** Microphone level, 0 to 1. */
  level: number
  /** Seconds since the level was last above SPEECH_LEVEL; zero while somebody is talking. */
  quietSeconds: number
  /** Milliseconds since the wake model was last asked. */
  sinceScoredMs: number
}
/**
 * Whether to ask the wake model about what the microphone is holding. An idle room never
 * reaches the model: scoring starts when the level says somebody is talking and continues
 * briefly after they stop, so a name finishing in silence is still inside the buffer.
 */
export function shouldScoreWake(scoring: WakeScoring) {
  if (scoring.sinceScoredMs < WAKE_SCORE_INTERVAL_MS) return false
  return scoring.level >= SPEECH_LEVEL || scoring.quietSeconds < WAKE_QUIET_SECONDS
}

export type PlaybackListen = {
  /** Seconds of speech heard since the reply started playing. */
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
