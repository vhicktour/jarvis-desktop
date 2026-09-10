import { useEffect, useRef, useState } from 'react'
import { type OrbState } from 'thinking-orbs'
import { motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react'
import { Settings2 } from 'lucide-react'
import { useJarvis } from './state'
import { IdleCore } from './IdleCore'

export function useActivity() {
  const { snapshot } = useJarvis()
  const task = snapshot.tasks.find((t) =>
    ['running', 'verifying', 'awaiting_approval', 'needs_reconciliation'].includes(t.state),
  )
  const voice = snapshot.voice.phase
  if (snapshot.approvals.length)
    return {
      label: 'Your approval is needed',
      mode: 'breathing' as OrbState,
      tone: 'attention',
      active: true,
    }
  if (voice === 'error')
    return {
      label: snapshot.voice.error ?? 'Voice needs attention',
      mode: 'breathing' as OrbState,
      tone: 'error',
      active: false,
    }
  if (voice === 'listening')
    return {
      label: snapshot.voice.handsFree
        ? 'Listening, hands-free. Click to finish.'
        : 'Listening. Click to finish.',
      mode: 'listening' as OrbState,
      tone: 'active',
      active: true,
    }
  if (voice === 'speaking')
    return {
      label: 'Speaking. Click to interrupt.',
      mode: 'composing' as OrbState,
      tone: 'active',
      active: true,
    }
  if (voice === 'transcribing')
    return {
      label: 'Understanding your words',
      mode: 'weaving' as OrbState,
      tone: 'active',
      active: true,
    }
  if (voice === 'thinking' || task)
    return {
      label: task?.stage ?? 'Thinking',
      mode: /search|inspect|read|context/i.test(task?.stage ?? '')
        ? ('searching' as OrbState)
        : task?.state === 'verifying'
          ? ('solving' as OrbState)
          : ('working' as OrbState),
      tone: 'active',
      active: true,
    }
  return {
    label: 'Ready when you are',
    mode: 'breathing' as OrbState,
    tone: 'neutral',
    active: false,
  }
}
export function Core({ showcase = false, mode }: { showcase?: boolean; mode?: OrbState }) {
  const { snapshot } = useJarvis()
  const activity = useActivity()
  const reduced = useReducedMotion() || snapshot.settings.reduceMotion
  const [settled, setSettled] = useState(false)
  const [visible, setVisible] = useState(!document.hidden)
  useEffect(() => {
    setSettled(false)
    if (activity.active) return
    const timer = setTimeout(() => setSettled(true), 8000)
    return () => clearTimeout(timer)
  }, [activity.active, activity.mode])
  useEffect(() => {
    const listener = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  }, [])
  const speaking = snapshot.voice.phase === 'speaking'
  const level = snapshot.voice.phase === 'listening' || speaking ? snapshot.voice.level : 0
  const speechEnergy = useSpring(0, { stiffness: 180, damping: 24 })
  const swayX = useMotionValue(0)
  const swayY = useMotionValue(0)
  const tilt = useMotionValue(0)
  useEffect(() => {
    speechEnergy.set(speaking && !reduced && visible ? level : 0)
  }, [speaking, reduced, visible, level, speechEnergy])
  useEffect(() => {
    if (!speaking || reduced || !visible) {
      swayX.set(0)
      swayY.set(0)
      tilt.set(0)
      return
    }
    let frame = 0
    const animate = (time: number) => {
      const energy = speechEnergy.get()
      swayX.set(Math.sin(time * 0.009) * energy * 2.1)
      swayY.set(Math.sin(time * 0.013 + 0.6) * energy * 1.3)
      tilt.set(Math.sin(time * 0.01) * energy * 2.4)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [speaking, reduced, visible, speechEnergy, swayX, swayY, tilt])
  return (
    <motion.div
      className={`core-visual ${activity.tone} ${showcase ? 'showcase' : ''}`}
      aria-hidden="true"
      style={{ x: swayX, y: swayY, rotate: tilt }}
    >
      <div
        className="core-aura"
        style={{
          opacity: activity.active ? 0.28 + level * 0.5 : 0.12,
          transform: `scale(${1 + level * 0.1})`,
        }}
      />
      <motion.div
        className="orb-particles"
        animate={{ scale: 0.84 + (reduced ? 0 : level * 0.18) }}
        transition={{ duration: reduced ? 0 : 0.12 }}
      >
        <IdleCore
          paused={!!reduced || !visible || (settled && !mode)}
          active={activity.active || !!mode}
          level={reduced ? 0 : level}
        />
      </motion.div>
    </motion.div>
  )
}
export function Orb() {
  const { command, snapshot } = useJarvis()
  const activity = useActivity()
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined)
  const menu = () => {
    void command({ type: 'overlay.form', form: 'menu' })
  }
  return (
    <div
      className="orb-shell"
      onPointerEnter={() => {
        void command({ type: 'overlay.interaction', active: true })
      }}
      onPointerLeave={() => {
        if (!drag.current) void command({ type: 'overlay.interaction', active: false })
      }}
    >
      <button
        className="orb-button"
        aria-label={`Jarvis. ${activity.label}`}
        onContextMenu={(event) => {
          event.preventDefault()
          menu()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            menu()
          }
          if (event.metaKey && event.altKey && event.key.startsWith('Arrow')) {
            event.preventDefault()
            void command({
              type: 'overlay.dock',
              edge: (
                {
                  ArrowLeft: 'left',
                  ArrowRight: 'right',
                  ArrowUp: 'top',
                  ArrowDown: 'bottom',
                } as const
              )[event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'],
            })
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          drag.current = { x: event.screenX, y: event.screenY, moved: false }
          event.currentTarget.setPointerCapture(event.pointerId)
          void command({
            type: 'overlay.drag',
            phase: 'start',
            x: event.screenX,
            y: event.screenY,
          })
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start) return
          if (Math.hypot(event.screenX - start.x, event.screenY - start.y) > 4) start.moved = true
          if (start.moved)
            void command({
              type: 'overlay.drag',
              phase: 'move',
              x: event.screenX,
              y: event.screenY,
            })
        }}
        onPointerUp={(event) => {
          if (!drag.current) return
          void command({ type: 'overlay.drag', phase: 'end', x: event.screenX, y: event.screenY })
          const moved = drag.current.moved
          drag.current = undefined
          if (!moved) void command({ type: 'voice.toggle' })
        }}
        onClick={(event) => {
          if (event.detail === 0) void command({ type: 'voice.toggle' })
        }}
      >
        <Core />
      </button>
      <button className="orb-menu-trigger" aria-label="Jarvis controls and settings" onClick={menu}>
        <Settings2 size={12} />
      </button>
    </div>
  )
}
