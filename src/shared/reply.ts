/**
 * How much Jarvis says.
 *
 * An instruction alone drifts — a model asked for one sentence writes four by the third
 * turn — so every length carries a ceiling as well, and the ceiling is what actually holds.
 * The ceilings are sized to the instruction: sixty tokens is a sentence or two said aloud in
 * about four seconds, which is what a person waiting on an answer will sit through.
 */

export const REPLY_LENGTHS = ['brief', 'measured', 'full'] as const
export type ReplyLength = (typeof REPLY_LENGTHS)[number]

export type ReplyShape = {
  /** Added to the system prompt, or empty when the length is left to the answer. */
  instruction: string
  /** The ceiling that holds when the instruction does not. */
  maxTokens: number
  /** The most a spoken reply on the duplex engine may run, in seconds of speech. */
  maxSpokenSeconds: number
  /** What Settings calls it. */
  label: string
  /** What Settings says it does. */
  description: string
}

const SHAPES: Record<ReplyLength, ReplyShape> = {
  brief: {
    instruction:
      ' Answer in one short sentence. No preamble, no restating the question, no offer of further help. If the honest answer is a single word, give the single word.',
    maxTokens: 60,
    maxSpokenSeconds: 8,
    label: 'Brief',
    description: 'One sentence. The answer and nothing around it.',
  },
  measured: {
    instruction:
      ' Answer in one or two sentences, the answer first. Add a third only when leaving it out would mislead.',
    maxTokens: 120,
    maxSpokenSeconds: 14,
    label: 'Measured',
    description: 'A sentence or two, and more only when it changes the answer.',
  },
  full: {
    instruction: '',
    maxTokens: 700,
    maxSpokenSeconds: 45,
    label: 'Full',
    description: 'As much as the thought needs. Best for reading rather than listening.',
  },
}

/** The instruction and ceiling for a chosen length. */
export function replyShape(length: ReplyLength): ReplyShape {
  return SHAPES[length] ?? SHAPES.measured
}
/** Settings offers these in order, shortest first. */
export function replyChoices() {
  return REPLY_LENGTHS.map((id) => ({ id, label: SHAPES[id].label }))
}
/**
 * Spoken replies carry their own constraint on top of the chosen length: no markdown
 * survives being read aloud, a list read as prose is worse than a sentence, and the filler
 * a model reaches for in writing is dead air when it is heard.
 */
export function spokenInstruction() {
  return ' Your reply will be spoken aloud, so use no markdown, lists or headings, and no filler before the answer.'
}
