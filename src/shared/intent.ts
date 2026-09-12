/** Fast routing for explicit requests; ambiguous wording stays with the conversation model. */
export function addressedText(text: string, name = 'Jarvis') {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .trim()
    .replace(new RegExp(`^(?:hey[,.!?\\s]+)?${escaped}\\b[,.!?:\\s]*`, 'i'), '')
    .trim()
}
export function requestedAction(text: string) {
  const request = requestText(text)
  return /^(?:create|write|add|schedule|remind me|run|execute|build|implement|fix|repair|install|uninstall|update|upgrade|manage|test|check|inspect|search|look up|find|open|launch|press|click|read|list|use|enable|disable|remove|delete|save|download|clone|set up)\b/i.test(
    request,
  )
}
export function nativeTask(text: string) {
  return /^(?:create\s+(?:a\s+)?file|write\s+(?:a\s+)?file|remind me|(?:add|create)\s+(?:a\s+)?reminder|schedule\s+(?:an?\s+)?(?:event|meeting|appointment)|(?:press|click)\b)/i.test(
    requestText(text),
  )
}
function requestText(text: string) {
  return addressedText(text).replace(
    /^(?:(?:can|could|would|will) you\s+|(?:i want|i need) you to\s+|please\s+)+/i,
    '',
  )
}
/** Explicit requests whose completion needs an effect receipt, not just successful file reads. */
export function requiredTaskEffect(text: string): string[] {
  const request = requestText(text)
  if (/^(?:install|add)\b[^.!?\n]*\bskill\b/i.test(request)) return ['skill.install']
  if (/^(?:remove|uninstall|delete)\b[^.!?\n]*\bskill\b/i.test(request)) return ['skill.remove']
  if (/^(?:run|execute)\b/i.test(request)) return ['agent.command', 'mcp.call']
  if (
    /^(?:build|implement|fix|repair|install|uninstall|update|upgrade|remove|delete|save|download|clone|set up)\b/i.test(
      request,
    )
  )
    return ['agent.command', 'mcp.call', 'skill.install', 'skill.remove']
  return []
}
export function endConversation(text: string) {
  return /^(?:stop|stop talking|stop listening|go to sleep|that's all|that is all|goodbye|bye|thanks[, ]+that's all)[.!\s]*$/i.test(
    addressedText(text),
  )
}
