/**
 * What a reply sounds like when it is spoken rather than read.
 *
 * A model writing for a screen reaches for markdown, and a synthesizer reads the punctuation out
 * or stumbles over it. Kept apart from the service worker so it can be checked without a voice.
 */

/** Text a synthesizer can read: the words, without the marks that were meant for the eye. */
export function spoken(text: string) {
  return (
    text
      // Fenced code is never worth reading aloud; say that it was there instead.
      .replace(/```[\s\S]*?```/g, ' (code) ')
      .replace(/`([^`]+)`/g, '$1')
      // Links keep their words and lose their addresses.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim()
  )
}

/** The first whole sentence in `text`, once one has finished, and what is left after it. */
export function firstSentence(text: string): [string, string] | undefined {
  // A decimal point, an abbreviation, or an ellipsis is not the end of a thought.
  const match = /[^.!?]*(?:\.(?!\d)|[!?])(?:["')\]]*)(?=\s|$)/.exec(text)
  if (!match) return undefined
  const end = match.index + match[0].length
  return [text.slice(0, end).trim(), text.slice(end)]
}

/** How a spoken reply is produced. */
export type ConversationEngine = 'pipeline' | 'duplex' | 'realtime'

/** The one duplex profile installed here; the catalogue's others have no adapter yet. */
export const DUPLEX_MODEL = 'lfm'

/** Components used together by the standard local voice route. */
export const LOCAL_VOICE_MODELS = [
  'whisper',
  'qwen',
  'kokoro',
  'silero',
  'smart-turn',
  'keyword',
] as const

export function localVoiceReady(qualified: (id: string) => boolean) {
  return qualified('qwen') && (qualified('whisper') || qualified('parakeet'))
}

/**
 * An engine is offered only where what it needs has been observed working on this Mac. The duplex
 * model has to have passed its own checks, and the cloud engine has to actually be connected.
 */
export function engineReady(
  engine: ConversationEngine,
  qualified: (id: string) => boolean,
  connected: (id: string) => boolean,
) {
  if (engine === 'duplex')
    return qualified(DUPLEX_MODEL) && (qualified('whisper') || qualified('parakeet'))
  if (engine === 'realtime') return connected('openai-realtime')
  return localVoiceReady(qualified)
}

/** Which engine actually runs, given what is ready. Nothing silently falls back to the cloud. */
export function engineInUse(
  chosen: ConversationEngine,
  qualified: (id: string) => boolean,
  connected: (id: string) => boolean,
): ConversationEngine {
  return engineReady(chosen, qualified, connected) ? chosen : 'pipeline'
}
