import { useEffect, useRef } from 'react'
import { makeProj } from 'thinking-orbs/engine'

const points = Array.from({ length: 420 }, (_, i) => {
  const y = 1 - (i / 419) * 2
  const radius = Math.sqrt(1 - y * y)
  const theta = Math.PI * (3 - Math.sqrt(5)) * i
  return { x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius }
})

/** Quiet rotation stops with the rest of the companion when idle or hidden. */
export function IdleCore({
  paused,
  active,
  level,
}: {
  paused: boolean
  active: boolean
  level: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const angle = useRef(0.6)
  const energy = useRef(level)
  useEffect(() => {
    energy.current = level
  }, [level])
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    element.width = 320
    element.height = 320
    context.setTransform(5, 0, 0, 5, 0, 0)
    let frame = 0
    let last = 0
    const draw = (time: number) => {
      if (last) angle.current += Math.min(time - last, 50) * (active ? 0.00022 : 0.00008)
      last = time
      context.clearRect(0, 0, 64, 64)
      const project = makeProj(angle.current, 0.16, 0, 0, 1)
      const rotated = points
        .map((p) => {
          const [x, y, z] = project(p.x, p.y, p.z)
          const ripple = paused
            ? 1
            : 1 +
              ((active ? 0.018 : 0) + energy.current * 0.065) *
                Math.sin(p.y * 4 + p.x * 2 + time * 0.003)
          return { x: x * ripple, y: y * ripple, z }
        })
        .sort((a, b) => a.z - b.z)
      for (const p of rotated) {
        const depth = (p.z + 1) / 2
        const perspective = 1 + p.z * 0.11
        context.beginPath()
        context.fillStyle = `rgba(${165 + Math.round(depth * 69)}, ${220 + Math.round(depth * 27)}, 255, ${0.12 + depth * 0.82})`
        context.arc(
          32 + p.x * 24 * perspective,
          32 + p.y * 24 * perspective,
          0.29 + depth * 0.35,
          0,
          Math.PI * 2,
        )
        context.fill()
      }
      if (!paused) frame = requestAnimationFrame(draw)
    }
    draw(0)
    return () => cancelAnimationFrame(frame)
  }, [paused, active])
  return <canvas ref={canvas} aria-hidden="true" className="idle-core" />
}
