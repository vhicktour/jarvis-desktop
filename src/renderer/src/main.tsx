import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/sora/latin-400.css'
import '@fontsource/sora/latin-500.css'
import '../styles/app.css'
import { AppState, useJarvis } from './state'
import { Orb } from './Orb'
import { Panel } from './Panels'
import { Settings } from './Settings'
import { previewAPI } from './preview'
import { Notices } from './ui'

if (!window.jarvis && import.meta.env.DEV) window.jarvis = previewAPI()
const surface = new URLSearchParams(location.search).get('surface') ?? 'orb'
function Preview() {
  const [settings, setSettings] = useState(false)
  const [panel, setPanel] = useState(false)
  const { form } = useJarvis()
  useEffect(
    () =>
      window.jarvis.subscribe((event) => {
        if (event.type === 'overlay') setPanel(event.form !== 'orb')
      }),
    [],
  )
  useEffect(() => {
    const show = () => setSettings(true)
    window.addEventListener('preview:settings', show)
    return () => window.removeEventListener('preview:settings', show)
  }, [])
  return (
    <div className="preview-stage">
      {settings && (
        <div className="preview-frame">
          <Settings />
        </div>
      )}
      {panel && (
        <div
          className="preview-panel"
          style={
            form === 'menu'
              ? { width: 280, height: 324 }
              : form === 'input'
                ? { height: 252, width: 380 }
                : undefined
          }
        >
          <Panel />
        </div>
      )}
      <div className="preview-orb">
        <Orb />
      </div>
      <div className="preview-bar">
        <span>DEVELOPMENT SCENARIO · SIMULATED STATE</span>
        <button onClick={() => setSettings(!settings)}>{settings ? 'Orb only' : 'Settings'}</button>
      </div>
    </div>
  )
}
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {}
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    return this.state.error ? (
      <div className="panel-shell" style={{ padding: 22 }}>
        <h2>Jarvis needs a moment.</h2>
        <p className="muted">{this.state.error}</p>
        <button className="button secondary" onClick={() => location.reload()}>
          Reload interface
        </button>
      </div>
    ) : (
      this.props.children
    )
  }
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppState>
        {window.jarvis?.surface === 'preview' ? (
          <Preview />
        ) : surface === 'settings' ? (
          <Settings />
        ) : surface === 'panel' ? (
          <Panel />
        ) : (
          <Orb />
        )}
      </AppState>
    </ErrorBoundary>
  </React.StrictMode>,
)
