import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Crop, X } from 'lucide-react'
import { containRegion, MINIMUM_REGION, type Rect } from '../../shared/geometry'
import { useJarvis } from './state'
import { Button } from './ui'

type Point = { x: number; y: number }
const STEP = 16
const NUDGE = 1
const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

function between(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(from.x - to.x),
    height: Math.abs(from.y - to.y),
  }
}

export function RegionSelect() {
  const { command } = useJarvis()
  const [rect, setRect] = useState<Rect>()
  const anchor = useRef<Point>(undefined)
  const shell = useRef<HTMLDivElement>(null)
  const view = () => ({ width: window.innerWidth, height: window.innerHeight })
  const cancel = () => {
    void command({ type: 'context.cancelRegion' })
  }
  const share = (value?: Rect) => {
    if (!value || value.width < MINIMUM_REGION || value.height < MINIMUM_REGION) return
    const bounded = containRegion(value, view())
    void command({ type: 'context.regionChosen', ...bounded })
  }
  useEffect(() => {
    shell.current?.focus()
  }, [])
  const keyboard = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      share(rect)
      return
    }
    const direction = ARROWS[event.key]
    if (!direction) return
    event.preventDefault()
    const step = event.altKey ? NUDGE : STEP
    const size = view()
    setRect((current) => {
      const base =
        current ??
        containRegion(
          {
            width: Math.min(480, size.width),
            height: Math.min(320, size.height),
            x: (size.width - Math.min(480, size.width)) / 2,
            y: (size.height - Math.min(320, size.height)) / 2,
          },
          size,
        )
      return containRegion(
        event.shiftKey
          ? {
              ...base,
              width: base.width + direction.x * step,
              height: base.height + direction.y * step,
            }
          : { ...base, x: base.x + direction.x * step, y: base.y + direction.y * step },
        size,
      )
    })
  }
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    anchor.current = { x: event.clientX, y: event.clientY }
    setRect({ x: event.clientX, y: event.clientY, width: 0, height: 0 })
  }
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (anchor.current) setRect(between(anchor.current, { x: event.clientX, y: event.clientY }))
  }
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!anchor.current) return
    const value = between(anchor.current, { x: event.clientX, y: event.clientY })
    anchor.current = undefined
    // A stray click is a cancelled drag, not a tiny selection.
    if (value.width < MINIMUM_REGION || value.height < MINIMUM_REGION) {
      setRect(undefined)
      return
    }
    setRect(value)
    share(value)
  }
  const readout = rect
    ? `${Math.round(rect.width)} × ${Math.round(rect.height)} points`
    : 'Nothing selected yet'
  return (
    <div
      ref={shell}
      className="region-shell"
      role="application"
      tabIndex={0}
      aria-label="Choose an area of the screen to share. Drag to draw it, or use the arrow keys to move it, Shift with the arrow keys to resize it, Enter to share it, and Escape to cancel."
      onKeyDown={keyboard}
      onPointerDown={start}
      onPointerMove={drag}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {rect ? (
        <div
          className="region-rect"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      ) : (
        <div className="region-veil" />
      )}
      <div
        className="region-hint"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <div className="region-hint-text">
          <span className="eyebrow">SHARE AN AREA</span>
          <p>
            Drag across what you want me to see. Arrow keys move it, Shift and the arrow keys resize
            it, Option makes each step finer.
          </p>
          <span className="metadata" role="status">
            {readout}
          </span>
        </div>
        <div className="actions">
          <Button variant="ghost" onPress={cancel}>
            <X size={13} />
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!rect || rect.width < MINIMUM_REGION || rect.height < MINIMUM_REGION}
            onPress={() => share(rect)}
          >
            <Crop size={13} />
            Share this area
          </Button>
        </div>
      </div>
    </div>
  )
}
