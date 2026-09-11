import { useState } from 'react'
import { Liquid } from 'liquid-gooey'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { replyChoices, type ReplyLength } from '../../../shared/reply'
import { useJarvis } from '../state'
import { Core, useActivity } from '../Orb'
import { Badge, Choice, Group, IconButton, Row, Toggle } from '../ui'

export function General() {
  const { snapshot, command } = useJarvis()
  const [shortcut, setShortcut] = useState(snapshot.settings.shortcut)
  const activity = useActivity()
  return (
    <>
      <div className="presence-card">
        <div className="presence-copy">
          <span className="eyebrow">YOUR PERSONAL COMPANION</span>
          <h2>
            Always
            <br />
            within reach.
          </h2>
          <p>
            A thought away.
            <br />
            An entire window only when you need it.
          </p>
          <Badge tone={activity.active ? 'active' : 'neutral'}>
            {activity.active ? activity.label : 'Standing by'}
          </Badge>
        </div>
        <div className="presence-art">
          <div className="presence-core">
            <Core showcase />
          </div>
          <div className="presence-coordinate">PERSONAL / LOCAL FIRST</div>
        </div>
      </div>
      <Group title="Make yourself heard">
        <Row title="Activation shortcut" description="Click the orb, or summon it from anywhere.">
          <div className="shortcut-editor">
            <input
              aria-label="Activation shortcut"
              value={shortcut}
              onChange={(event) => setShortcut(event.target.value)}
              onKeyDown={(event) => {
                if (event.metaKey || event.ctrlKey) {
                  event.preventDefault()
                  const key = event.key
                  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key))
                    setShortcut(
                      [
                        event.metaKey || event.ctrlKey ? 'CommandOrControl' : '',
                        event.shiftKey ? 'Shift' : '',
                        event.altKey ? 'Alt' : '',
                        key.toUpperCase(),
                      ]
                        .filter(Boolean)
                        .join('+'),
                    )
                }
              }}
              onBlur={() => {
                if (shortcut !== snapshot.settings.shortcut)
                  void command({ type: 'settings.update', patch: { shortcut } })
              }}
            />
            <span>
              {snapshot.settings.shortcut
                .replace(/CommandOrControl|Command|Meta/g, '⌘')
                .replace(/Control/g, '⌃')
                .replace(/Shift/g, '⇧')
                .replace(/Alt|Option/g, '⌥')
                .replaceAll('+', ' ')}
            </span>
          </div>
        </Row>
        {snapshot.diagnostics.shortcutError && (
          <p className="error-text">{snapshot.diagnostics.shortcutError}</p>
        )}
        <Toggle
          label="Speak responses"
          description="Concise answers, with a composed British voice."
          selected={snapshot.settings.speakReplies}
          onChange={(speakReplies) => {
            void command({ type: 'settings.update', patch: { speakReplies } })
          }}
        />
        <Row
          title="How much Jarvis says"
          description="Applies to what you read as well as what you hear."
        >
          <Choice
            label="Reply length"
            value={snapshot.settings.replyLength}
            options={replyChoices()}
            onChange={(replyLength) => {
              void command({
                type: 'settings.update',
                patch: { replyLength: replyLength as ReplyLength },
              })
            }}
          />
        </Row>
      </Group>
      <Group title="Your corner of the world">
        <Toggle
          label="Pin in place"
          description="Keep the orb where you put it."
          selected={snapshot.settings.pinned}
          onChange={(pinned) => {
            void command({ type: 'settings.update', patch: { pinned } })
          }}
        />
        <Row title="Dock position" description="Drag the orb to move it. It settles near an edge.">
          <Liquid fill="rgba(142,231,245,.08)">
            <div className="dock-buttons">
              {[
                { edge: 'left', icon: ArrowLeft },
                { edge: 'top', icon: ArrowUp },
                { edge: 'bottom', icon: ArrowDown },
                { edge: 'right', icon: ArrowRight },
              ].map(({ edge, icon: Icon }) => (
                <Liquid.Item key={edge} morph={{ contentBlur: 0 }}>
                  <IconButton
                    label={`Dock ${edge}`}
                    onPress={() => {
                      void command({
                        type: 'overlay.dock',
                        edge: edge as 'left' | 'right' | 'top' | 'bottom',
                      })
                    }}
                  >
                    <Icon size={15} />
                  </IconButton>
                </Liquid.Item>
              ))}
            </div>
          </Liquid>
        </Row>
        <Toggle
          label="Start with your Mac"
          description="Ready when your day begins."
          selected={snapshot.settings.startAtLogin}
          onChange={(startAtLogin) => {
            void command({ type: 'settings.update', patch: { startAtLogin } })
          }}
        />
      </Group>
      <Group title="A comfortable presence">
        <Toggle
          label="Reduce motion"
          description="Quiet particle effects and instant transitions."
          selected={snapshot.settings.reduceMotion}
          onChange={(reduceMotion) => {
            void command({ type: 'settings.update', patch: { reduceMotion } })
          }}
        />
        <Toggle
          label="Reduce transparency"
          description="A solid, high-contrast surface."
          selected={snapshot.settings.reduceTransparency}
          onChange={(reduceTransparency) => {
            void command({ type: 'settings.update', patch: { reduceTransparency } })
          }}
        />
      </Group>
    </>
  )
}
