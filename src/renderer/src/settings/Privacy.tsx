import { ArrowUpRight, Download, LockKeyhole } from 'lucide-react'
import { useJarvis } from '../state'
import { Badge, Button, Choice, Group, Row, Toggle } from '../ui'

export function Privacy() {
  const { snapshot, command } = useJarvis()
  return (
    <>
      <div className="privacy-intro">
        <LockKeyhole size={26} />
        <div>
          <h2>Personal by design.</h2>
          <p>Local speech. Encrypted memory. Context you choose.</p>
        </div>
      </div>
      <Group title="Connections on your terms">
        <Toggle
          label="Local-only mode"
          description="Keep conversations and tasks on this Mac. Cloud providers are disabled."
          selected={snapshot.settings.privacyMode === 'local-only'}
          onChange={(selected) => {
            void command({
              type: 'settings.update',
              patch: { privacyMode: selected ? 'local-only' : 'local-first' },
            })
          }}
        />
      </Group>
      <Group
        title="macOS permissions"
        detail="Permission grants are handled by macOS and can be revoked at any time."
      >
        {[
          {
            id: 'microphone',
            title: 'Microphone',
            detail: 'Listen when you activate the orb.',
            granted: snapshot.permissions.microphone === 'granted',
          },
          {
            id: 'screen',
            title: 'Screen Recording',
            detail: 'Capture only a deliberately selected window.',
            granted: snapshot.permissions.screen === 'granted',
          },
          {
            id: 'accessibility',
            title: 'Accessibility',
            detail: 'Move the orb away from a focused control.',
            granted: snapshot.permissions.accessibility,
          },
          {
            id: 'calendars',
            title: 'Calendar',
            detail: 'Read events through your Apple Calendar connection.',
            granted: ['fullAccess', 'authorized'].includes(snapshot.permissions.calendars ?? ''),
          },
          {
            id: 'reminders',
            title: 'Reminders',
            detail: 'Read lists through your Reminders connection.',
            granted: ['fullAccess', 'authorized'].includes(snapshot.permissions.reminders ?? ''),
          },
        ].map((permission) => (
          <Row key={permission.id} title={permission.title} description={permission.detail}>
            {permission.granted ? (
              <Badge tone="active">Allowed</Badge>
            ) : (
              <Button
                onPress={() => {
                  void command({ type: 'permission.request', permission: permission.id as any })
                }}
              >
                Allow access
                <ArrowUpRight size={12} />
              </Button>
            )}
          </Row>
        ))}
      </Group>
      <Group title="Keep only what is useful">
        <Row title="Conversations" description="Automatically delete older transcripts.">
          <Choice
            label="Transcript retention"
            value={String(snapshot.settings.transcriptDays)}
            onChange={(value) => {
              void command({ type: 'settings.update', patch: { transcriptDays: Number(value) } })
            }}
            options={[
              { id: '0', label: 'Do not retain' },
              { id: '7', label: '7 days' },
              { id: '30', label: '30 days' },
              { id: '90', label: '90 days' },
            ]}
          />
        </Row>
        <Row title="Task receipts" description="Evidence, approvals, and completed effects.">
          <Choice
            label="Receipt retention"
            value={String(snapshot.settings.receiptDays)}
            onChange={(value) => {
              void command({ type: 'settings.update', patch: { receiptDays: Number(value) } })
            }}
            options={[
              { id: '30', label: '30 days' },
              { id: '90', label: '90 days' },
              { id: '365', label: '1 year' },
            ]}
          />
        </Row>
        <Row title="Explicit memories" description="Kept until you choose to forget them.">
          <Badge>Until deleted</Badge>
        </Row>
      </Group>
      <Group title="Your information">
        <Row
          title="Export your data"
          description="Save a readable copy of your conversations, tasks, and memories."
        >
          <Button
            onPress={() => {
              void command({ type: 'data.export' })
            }}
          >
            <Download size={13} />
            Export
          </Button>
        </Row>
      </Group>
    </>
  )
}
