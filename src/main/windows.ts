import { BrowserWindow, screen, app } from 'electron'
import glass from 'electron-liquid-glass'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OverlayForm, Settings, AppEvent } from '../shared/contracts'

type Rect = { x: number; y: number; width: number; height: number }
export function clamp(bounds: Rect, area: Rect, inset = 24): Rect {
  const width = Math.min(bounds.width, area.width - inset * 2)
  const height = Math.min(bounds.height, area.height - inset * 2)
  return {
    width,
    height,
    x: Math.round(
      Math.max(area.x + inset, Math.min(bounds.x, area.x + area.width - width - inset)),
    ),
    y: Math.round(
      Math.max(area.y + inset, Math.min(bounds.y, area.y + area.height - height - inset)),
    ),
  }
}
const sizes: Record<OverlayForm, [number, number]> = {
  orb: [72, 72],
  menu: [280, 324],
  input: [380, 252],
  conversation: [400, 500],
  task: [400, 520],
  approval: [400, 520],
  context: [400, 480],
}

export class WindowCoordinator {
  orb: BrowserWindow
  panel: BrowserWindow
  settings?: BrowserWindow
  selections: BrowserWindow[] = []
  form: OverlayForm = 'orb'
  glass = false
  private preferences?: Settings
  private interacting = false
  private dragging = false
  private dragOffset = { x: 0, y: 0 }
  private positions: Record<string, Rect> = {}
  private clickTimer: NodeJS.Timeout
  private lastMoved = 0
  private obstruction?: { key: string; since: number }
  private settingsSection = 'general'
  constructor(
    private root: string,
    private emit: (event: AppEvent) => void,
  ) {
    try {
      this.positions = JSON.parse(
        readFileSync(join(app.getPath('userData'), 'window-positions.json'), 'utf8'),
      )
    } catch {
      /* First launch. */
    }
    this.orb = this.make('orb', 72, 72, 36)
    this.panel = this.make('panel', 400, 480, 24)
    const display = screen.getPrimaryDisplay()
    const area = display.workArea
    this.orb.setBounds(
      clamp(
        this.positions[String(display.id)] ?? {
          x: area.x + area.width - 96,
          y: area.y + area.height - 96,
          width: 72,
          height: 72,
        },
        area,
      ),
    )
    this.panel.on('blur', () => {
      if (this.form === 'menu') this.setForm('orb')
    })
    screen.on('display-removed', () => this.restoreDisplay())
    screen.on('display-metrics-changed', () => this.restoreDisplay())
    this.clickTimer = setInterval(() => this.hitTest(), 60)
    this.clickTimer.unref()
  }
  private make(
    surface: 'orb' | 'panel' | 'settings' | 'region',
    width: number,
    height: number,
    radius: number,
    glassy = true,
  ) {
    const overlay = surface !== 'settings'
    const window = new BrowserWindow({
      width,
      height,
      minWidth: overlay ? undefined : 800,
      minHeight: overlay ? undefined : 600,
      title: surface === 'settings' ? 'Jarvis Settings' : 'Jarvis',
      type: overlay && surface !== 'region' ? 'panel' : undefined,
      frame: !overlay,
      titleBarStyle: overlay ? undefined : 'hiddenInset',
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      show: false,
      resizable: !overlay,
      maximizable: !overlay,
      minimizable: !overlay,
      fullscreenable: !overlay,
      skipTaskbar: overlay,
      alwaysOnTop: overlay,
      roundedCorners: true,
      webPreferences: {
        preload: join(this.root, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        devTools: !app.isPackaged,
        additionalArguments: [
          `--jarvis-surface=${surface === 'settings' ? 'settings' : 'overlay'}`,
        ],
      },
    })
    if (overlay) {
      window.setAlwaysOnTop(true, 'floating')
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      })
      window.setHiddenInMissionControl(true)
    }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.once('did-finish-load', () => {
      // A region selector must show the real desktop, so no material is layered over it.
      if (!glassy) return window.webContents.invalidate()
      try {
        const id = glass.addView(window.getNativeWindowHandle(), {
          cornerRadius: radius,
          tintColor: '#08121A44',
        })
        if (id >= 0) this.glass = glass.isGlassSupported()
      } catch (error) {
        console.error('Glass material:', error instanceof Error ? error.message : 'unavailable')
      }
      window.webContents.invalidate()
    })
    const query = { surface }
    if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged)
      void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query)}`)
    else void window.loadFile(join(this.root, '../renderer/index.html'), { query })
    return window
  }
  update(preferences: Settings) {
    this.preferences = preferences
  }
  surfaceReady(id: number) {
    const window = this.all().find((item) => item.webContents.id === id)
    if (!window) return
    window.webContents.invalidate()
    if (window === this.orb) window.showInactive()
    // Drawing a region is explicit interaction, so its window may take the keyboard.
    if (this.selections.includes(window)) {
      window.show()
      window.focus()
    }
    if (window === this.settings) {
      window.webContents.send('jarvis:event', { type: 'section', section: this.settingsSection })
      window.setOpacity(0)
      window.show()
      void window.webContents.capturePage().finally(() => {
        setTimeout(() => {
          if (!window.isDestroyed()) window.setOpacity(1)
        }, 60)
      })
    }
  }
  all() {
    return [this.orb, this.panel, this.settings, ...this.selections].filter(
      (w): w is BrowserWindow => !!w && !w.isDestroyed(),
    )
  }
  /** One selector per display, so a region can be drawn on whichever screen holds it. */
  openSelection() {
    this.closeSelection()
    this.setForm('orb')
    app.focus({ steal: true })
    for (const display of screen.getAllDisplays()) {
      const window = this.make('region', display.bounds.width, display.bounds.height, 0, false)
      window.setBounds(display.bounds)
      window.setAlwaysOnTop(true, 'screen-saver')
      window.on('closed', () => {
        this.selections = this.selections.filter((item) => item !== window)
      })
      this.selections.push(window)
    }
  }
  closeSelection() {
    for (const window of this.selections.splice(0)) if (!window.isDestroyed()) window.destroy()
  }
  selectionBounds(contents: Electron.WebContents) {
    return this.selections.find((window) => window.webContents === contents)?.getBounds()
  }
  broadcast(event: AppEvent) {
    for (const window of this.all()) window.webContents.send('jarvis:event', event)
  }
  setForm(form: OverlayForm, focus = true) {
    this.form = form
    if (form === 'orb') {
      this.panel.hide()
      this.interacting = false
      this.emit({ type: 'overlay', form })
      return
    }
    const [width, height] = sizes[form]
    const orb = this.orb.getBounds()
    const display = screen.getDisplayMatching(orb)
    const area = display.workArea
    const right = orb.x > area.x + area.width / 2
    this.panel.setBounds(
      clamp(
        { x: right ? orb.x + orb.width - width : orb.x, y: orb.y - height - 12, width, height },
        area,
      ),
    )
    this.emit({ type: 'overlay', form })
    if (focus) this.panel.show()
    else this.panel.showInactive()
    this.panel.webContents.send('jarvis:event', { type: 'overlay', form })
  }
  openSettings(section = 'general') {
    this.settingsSection = section
    this.setForm('orb')
    if (!this.settings || this.settings.isDestroyed()) {
      this.settings = this.make('settings', 920, 710, 18)
      this.settings.on('closed', () => {
        this.settings = undefined
      })
    } else {
      this.settings.show()
      this.settings.webContents.send('jarvis:event', { type: 'section', section })
    }
  }
  interaction(active: boolean) {
    this.interacting = active
  }
  drag(phase: 'start' | 'move' | 'end', x: number, y: number) {
    if (phase === 'start') {
      const b = this.orb.getBounds()
      this.dragOffset = { x: x - b.x, y: y - b.y }
      this.dragging = true
      this.setForm('orb')
      return
    }
    if (!this.dragging) return
    if (phase === 'move') {
      const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
      this.orb.setBounds(
        clamp(
          { x: x - this.dragOffset.x, y: y - this.dragOffset.y, width: 72, height: 72 },
          display.workArea,
          6,
        ),
      )
      return
    }
    this.dragging = false
    const b = this.orb.getBounds()
    const area = screen.getDisplayMatching(b).workArea
    const distances = [
      { edge: 'left', distance: b.x - area.x },
      { edge: 'right', distance: area.x + area.width - b.x - 72 },
      { edge: 'top', distance: b.y - area.y },
      { edge: 'bottom', distance: area.y + area.height - b.y - 72 },
    ].sort((a, b) => a.distance - b.distance)
    if (distances[0].distance < 70)
      this.dock(distances[0].edge as 'left' | 'right' | 'top' | 'bottom')
    else {
      this.orb.setBounds(clamp(b, area))
      this.savePosition()
    }
  }
  dock(edge: 'left' | 'right' | 'top' | 'bottom') {
    const b = this.orb.getBounds()
    const a = screen.getDisplayMatching(b).workArea
    if (edge === 'left') b.x = a.x + 24
    if (edge === 'right') b.x = a.x + a.width - 96
    if (edge === 'top') b.y = a.y + 24
    if (edge === 'bottom') b.y = a.y + a.height - 96
    this.orb.setBounds(clamp(b, a))
    this.savePosition()
  }
  avoid(rect: Rect | null) {
    if (this.orb.isDestroyed()) return
    if (
      !rect ||
      this.preferences?.pinned ||
      this.dragging ||
      this.interacting ||
      this.form !== 'orb' ||
      Date.now() - this.lastMoved < 5000
    ) {
      this.obstruction = undefined
      return
    }
    const b = this.orb.getBounds()
    const intersects =
      b.x < rect.x + rect.width + 12 &&
      b.x + b.width > rect.x - 12 &&
      b.y < rect.y + rect.height + 12 &&
      b.y + b.height > rect.y - 12
    if (!intersects) {
      this.obstruction = undefined
      return
    }
    const key = `${Math.round(rect.x / 8)},${Math.round(rect.y / 8)},${Math.round(rect.width / 8)}`
    if (this.obstruction?.key !== key) {
      this.obstruction = { key, since: Date.now() }
      return
    }
    if (Date.now() - this.obstruction.since < 1200) return
    const area = screen.getDisplayMatching(b).workArea
    const y = b.y > area.y + area.height / 2 ? rect.y - 96 : rect.y + rect.height + 24
    this.orb.setBounds(clamp({ ...b, y }, area), !this.preferences?.reduceMotion)
    this.lastMoved = Date.now()
    this.obstruction = undefined
  }
  private restoreDisplay() {
    if (this.orb.isDestroyed()) return
    const b = this.orb.getBounds()
    this.orb.setBounds(clamp(b, screen.getDisplayMatching(b).workArea))
    if (this.form !== 'orb') this.setForm(this.form, false)
  }
  private savePosition() {
    const b = this.orb.getBounds()
    this.positions[String(screen.getDisplayMatching(b).id)] = b
    writeFileSync(
      join(app.getPath('userData'), 'window-positions.json'),
      JSON.stringify(this.positions),
      { mode: 0o600 },
    )
    this.lastMoved = Date.now()
  }
  private hitTest() {
    if (this.orb.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const b = this.orb.getBounds()
    const outside = Math.hypot(cursor.x - b.x - 36, cursor.y - b.y - 36) > 36
    this.orb.setIgnoreMouseEvents(outside && !this.dragging, { forward: true })
    if (!this.panel.isDestroyed() && this.panel.isVisible()) {
      const p = this.panel.getBounds()
      const x = Math.abs(cursor.x - p.x - p.width / 2) - (p.width / 2 - 24)
      const y = Math.abs(cursor.y - p.y - p.height / 2) - (p.height / 2 - 24)
      this.panel.setIgnoreMouseEvents(Math.hypot(Math.max(0, x), Math.max(0, y)) > 24, {
        forward: true,
      })
    }
  }
  destroy() {
    clearInterval(this.clickTimer)
    this.closeSelection()
    for (const window of this.all()) window.destroy()
  }
}
