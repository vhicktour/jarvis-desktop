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
