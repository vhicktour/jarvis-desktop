import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { AppSnapshot, Command, OverlayForm } from '../../shared/contracts'
import { emptySnapshot } from '../../shared/defaults'

type Notice = { id: number; message: string; tone: 'info' | 'success' | 'error' }
type State = {
  snapshot: AppSnapshot
  form: OverlayForm
  section: string
  setSection: (section: string) => void
  command: <T = any>(command: Command) => Promise<T | undefined>
  notice?: Notice
  dismiss: () => void
  busy: Set<string>
}
const Context = createContext<State | null>(null)
export function AppState({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [form, setForm] = useState<OverlayForm>('menu')
  const [section, setSection] = useState('general')
  const [notice, setNotice] = useState<Notice>()
  const [busy, setBusy] = useState(new Set<string>())
  const inFlight = useRef(new Set<string>())
  const command = useCallback(async <T,>(value: Command): Promise<T | undefined> => {
    const passive = value.type === 'overlay.drag' || value.type === 'overlay.interaction'
    if (!passive && inFlight.current.has(value.type)) return
    if (!passive) {
      inFlight.current.add(value.type)
      setBusy((previous) => new Set(previous).add(value.type))
    }
    try {
      return await window.jarvis.command<T>(value)
    } catch (error) {
      setNotice({
        id: Date.now(),
        message: error instanceof Error ? error.message : 'Something went wrong. Please try again.',
        tone: 'error',
      })
      return undefined
    } finally {
      if (!passive) {
        inFlight.current.delete(value.type)
        setBusy((previous) => {
          const next = new Set(previous)
          next.delete(value.type)
          return next
        })
      }
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    const refresh = () =>
      window.jarvis
        .command<AppSnapshot>({ type: 'snapshot' })
        .then((value) => {
          if (!cancelled) setSnapshot(value)
        })
        .catch(() => {})
    void refresh()
    const timer = setTimeout(refresh, 1000)
    const unsubscribe = window.jarvis.subscribe((event) => {
      if (event.type === 'snapshot') setSnapshot(event.snapshot)
      if (event.type === 'overlay') setForm(event.form)
      if (event.type === 'section') setSection(event.section)
      if (event.type === 'notice') setNotice({ ...event, id: Date.now() })
    })
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled && window.jarvis.surface !== 'preview')
            void window.jarvis.command({ type: 'surface.ready' })
        }),
      ),
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(snapshot.settings.reduceMotion)
    document.documentElement.dataset.opaque = String(snapshot.settings.reduceTransparency)
    document.documentElement.dataset.glass = String(snapshot.diagnostics.glass)
  }, [
    snapshot.settings.reduceMotion,
    snapshot.settings.reduceTransparency,
    snapshot.diagnostics.glass,
  ])
  return (
    <Context.Provider
      value={{
        snapshot,
        command,
        form,
        section,
        setSection,
        notice,
        dismiss: () => setNotice(undefined),
        busy,
      }}
    >
      {children}
    </Context.Provider>
  )
}
export function useJarvis() {
  const context = useContext(Context)
  if (!context) throw new Error('Jarvis state is missing.')
  return context
}
