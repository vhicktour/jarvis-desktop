import { emptySnapshot } from '../../shared/defaults'
import { withVoiceDependencies } from '../../shared/turn'
import type { AppEvent, AppSnapshot, Command, JarvisAPI, OverlayForm } from '../../shared/contracts'

/** Development-only design surface. Never loaded by the installed application. */
export function previewAPI(): JarvisAPI {
  const snapshot = emptySnapshot()
  snapshot.diagnostics.chip = 'Apple M1 Pro'
  snapshot.diagnostics.memoryGB = 16
  // The design surface shows the states a qualified Mac reaches; only the application judges one.
  for (const model of snapshot.models)
    if (!model.experimental) {
      model.status = 'installed'
      model.revision = 'preview'
      model.qualified = true
    }
  const listeners = new Set<(event: AppEvent) => void>()
  const emit = (event: AppEvent) => listeners.forEach((listener) => listener(event))
  let meter: ReturnType<typeof setInterval> | undefined
  let started = 0
  const updateMeter = () => {
    if (meter) clearInterval(meter)
    meter = undefined
    snapshot.voice.level = 0
    if (snapshot.voice.phase !== 'speaking' && snapshot.voice.phase !== 'listening') return
    started = performance.now()
    meter = setInterval(() => {
      if (document.hidden) return
      const seconds = (performance.now() - started) / 1000
      const phrase = Math.max(0, Math.sin(seconds * 1.9))
      snapshot.voice.level = phrase * (0.2 + 0.6 * Math.abs(Math.sin(seconds * 7.3)))
      emit({ type: 'snapshot', snapshot: structuredClone(snapshot) })
    }, 80)
  }
  return {
    surface: 'preview',
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size && meter) {
          clearInterval(meter)
          meter = undefined
        }
      }
    },
    async command<T>(command: Command): Promise<T> {
      if (command.type === 'snapshot') return structuredClone(snapshot) as T
      if (command.type === 'settings.update')
        // The service settles the same dependency, so the design surface has to show it too.
        Object.assign(
          snapshot.settings,
          withVoiceDependencies({ ...snapshot.settings, ...command.patch }),
        )
      else if (command.type === 'overlay.form') emit({ type: 'overlay', form: command.form })
      else if (command.type === 'settings.open') {
        emit({ type: 'section', section: command.section ?? 'general' })
        window.dispatchEvent(new CustomEvent('preview:settings'))
      } else if (command.type === 'context.selectRegion')
        window.dispatchEvent(new CustomEvent('preview:region'))
      else if (command.type === 'context.cancelRegion')
        window.dispatchEvent(new CustomEvent('preview:region-closed'))
      else if (command.type === 'context.regionChosen')
        window.dispatchEvent(
          new CustomEvent('preview:region-closed', {
            detail: {
              x: command.x,
              y: command.y,
              width: command.width,
              height: command.height,
            },
          }),
        )
      else if (command.type === 'voice.toggle') {
        snapshot.voice.phase = snapshot.voice.phase === 'off' ? 'listening' : 'off'
        snapshot.voice.handsFree =
          snapshot.voice.phase === 'listening' && snapshot.settings.handsFree
      } else if (command.type === 'voice.audition')
        snapshot.voice.phase = snapshot.voice.phase === 'speaking' ? 'off' : 'speaking'
      else if (command.type === 'voice.stopSpeech') snapshot.voice.phase = 'off'
      else if (command.type.startsWith('overlay.')) return true as T
      else throw new Error('Development preview. Open the Electron app to use this capability.')
      if (command.type.startsWith('voice.')) updateMeter()
      emit({ type: 'snapshot', snapshot: structuredClone(snapshot) })
      return true as T
    },
  }
}
