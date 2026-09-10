import { createHash, randomUUID } from 'node:crypto'

export const uid = () => randomUUID()
export const now = () => new Date().toISOString()
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? 'null'
}
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : canonical(value))
    .digest('hex')
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[^\s"']+|ya29\.[^\s"']+)/g, '[redacted]')
    .slice(0, 1800)
}
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
export function deadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`${label} timed out.`)), ms)
    const abort = () => done(new Error('Cancelled.'))
    const done = (error?: unknown, result?: T) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(result as T)
    }
    if (signal?.aborted) return done(new Error('Cancelled.'))
    signal?.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => done(undefined, value),
      (error) => done(error),
    )
  })
}
