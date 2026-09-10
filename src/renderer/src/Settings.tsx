import { type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Activity,
  AudioLines,
  BrainCircuit,
  Clock3,
  Link2,
  Settings2,
  Shield,
  Sparkles,
} from 'lucide-react'
import { useJarvis } from './state'
import { Notices } from './ui'
import { General } from './settings/General'
import { Voice } from './settings/Voice'
import { Models } from './settings/Models'
import { Connections } from './settings/Connections'
import { Memory } from './settings/Memory'
import { Routines } from './settings/Routines'
import { Privacy } from './settings/Privacy'
import { Diagnostics } from './settings/Diagnostics'

const sections = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'voice', label: 'Voice & sound', icon: AudioLines },
  { id: 'models', label: 'Local models', icon: BrainCircuit },
  { id: 'connections', label: 'Connections', icon: Link2 },
  { id: 'memory', label: 'Memory', icon: Clock3 },
  { id: 'routines', label: 'Routines', icon: Sparkles },
  { id: 'privacy', label: 'Privacy & access', icon: Shield },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity },
]

const descriptions: Record<string, string> = {
  general: 'A quiet presence. Tuned to you.',
  voice: 'A familiar voice, and room for yours.',
  models: 'Intelligence that stays on your Mac.',
  connections: 'Bring in a specialist when you need one.',
  memory: 'The useful things, remembered with care.',
  routines: 'A little less to keep in your head.',
  privacy: 'Your attention. Your information. Your call.',
  diagnostics: 'A clear view of what is working.',
}

export function Settings() {
  const { section, setSection, snapshot } = useJarvis()
  const selected = sections.find((s) => s.id === section) ?? sections[0]
  const pages: Record<string, ReactNode> = {
    general: <General />,
    voice: <Voice />,
    models: <Models />,
    connections: <Connections />,
    memory: <Memory />,
    routines: <Routines />,
    privacy: <Privacy />,
    diagnostics: <Diagnostics />,
  }
  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <div className="titlebar-drag" />
        <div className="settings-brand">
          <span className="wordmark">
            JARVIS<span>°</span>
          </span>
          <span className="brand-caption">AT YOUR SIDE</span>
        </div>
        <nav aria-label="Settings sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`nav-item ${selected.id === id ? 'selected' : ''}`}
              aria-current={selected.id === id ? 'page' : undefined}
            >
              {selected.id === id && (
                <motion.span
                  className="nav-selection"
                  layoutId="settings-selection"
                  transition={{
                    type: 'spring',
                    stiffness: 480,
                    damping: 40,
                    duration: snapshot.settings.reduceMotion ? 0 : undefined,
                  }}
                />
              )}
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          <div>
            On your Mac<span>Personal preview · 0.1.0</span>
          </div>
        </div>
      </aside>
      <main className="settings-main">
        <header className="settings-header">
          <div className="breadcrumb">
            SETTINGS<span>/</span>
            {selected.label.toUpperCase()}
          </div>
          <div className="settings-heading">
            <div>
              <h1>{selected.label}</h1>
              <p>{descriptions[selected.id]}</p>
            </div>
            <div className="header-mark">
              J<span>•</span>
            </div>
          </div>
        </header>
        <div className="settings-scroll scroll-area">
          <AnimatePresence mode="wait">
            <motion.div
              key={selected.id}
              initial={{ opacity: 0, y: snapshot.settings.reduceMotion ? 0 : 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: snapshot.settings.reduceMotion ? 0 : 0.16 }}
            >
              {pages[selected.id]}
            </motion.div>
          </AnimatePresence>
          <footer className="settings-footnote">
            <span>THOUGHTFULLY PRESENT.</span>
            <span>QUIETLY CAPABLE.</span>
          </footer>
        </div>
      </main>
      <Notices />
    </div>
  )
}
