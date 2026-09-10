import { Activity, Download } from 'lucide-react'
import { useJarvis } from '../state'
import { Badge, Button, Group, Row } from '../ui'

export function Diagnostics() {
  const { snapshot, command } = useJarvis()
  const d = snapshot.diagnostics
  return (
    <>
      <div className="system-banner">
        <div className="system-symbol">
          <Activity size={24} />
        </div>
        <div>
          <h2>
            {d.workerErrors.length ? 'Something needs attention.' : 'A clear view of Jarvis.'}
          </h2>
          <p>Version 0.1.0 · Personal preview</p>
        </div>
        <Button
          onPress={() => {
            void command({ type: 'diagnostics.refresh' })
          }}
        >
          Refresh
        </Button>
      </div>
      <Group title="This Mac">
        {[
          { title: 'System', value: `${d.platform} · ${d.chip}` },
          { title: 'Unified memory', value: `${d.memoryGB} GB` },
          { title: 'Application memory', value: `${d.appMemoryMB} MB · model process excluded` },
          { title: 'Native Liquid Glass', value: d.glass ? 'Active' : 'Fallback material' },
          { title: 'Native helper', value: d.native ? 'Connected' : 'Unavailable' },
          {
            title: 'Encrypted database',
            value: d.databaseEncrypted ? 'Unlocked with Keychain' : 'Starting',
          },
          { title: 'Local model runtime', value: d.modelRuntime ? 'Connected' : 'Not installed' },
        ].map((row) => (
          <Row key={row.title} title={row.title}>
            <span className="diagnostic-value">{row.value}</span>
          </Row>
        ))}
      </Group>
      <Group
        title="Verification status"
        detail="A passed build is only the beginning. Device-specific benchmarks are reported separately."
      >
        <Row
          title="Audio interruption"
          description="Target p95 ≤ 150 ms across supported audio routes."
        >
          <Badge tone="attention">Not measured</Badge>
        </Row>
        <Row title="Combined memory" description="Target ≤ 8 GB with the standard model workload.">
          <Badge tone="attention">Not measured</Badge>
        </Row>
        <Row title="Full-screen Spaces" description="Manual validation on your Mac is required.">
          <Badge tone="attention">Pending</Badge>
        </Row>
      </Group>
      {d.workerErrors.length > 0 && (
        <Group title="Recent issues">
          {d.workerErrors.map((error, index) => (
            <p className="error-text" key={index}>
              {error}
            </p>
          ))}
        </Group>
      )}
      <div className="actions">
        <Button
          onPress={() => {
            void command({ type: 'diagnostics.export' })
          }}
        >
          <Download size={14} />
          Export diagnostics
        </Button>
        <Button
          variant="ghost"
          onPress={() => {
            void command({ type: 'app.quit' })
          }}
        >
          Quit Jarvis
        </Button>
      </div>
    </>
  )
}
