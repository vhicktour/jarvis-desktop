import {
  app,
  ipcMain,
  globalShortcut,
  dialog,
  utilityProcess,
  powerMonitor,
  session,
  shell,
  Menu,
} from 'electron'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { cpus, totalmem } from 'node:os'
import {
  Command,
  MAX_MESSAGE_BYTES,
  type AppEvent,
  type AppSnapshot,
  type Result,
} from '../shared/contracts'
import { emptySnapshot } from '../shared/defaults'
import { JsonProcess } from '../core/process'
import { safeError, uid } from '../core/util'
import { WindowCoordinator } from './windows'

const root = dirname(fileURLToPath(import.meta.url))
let windows: WindowCoordinator
let native: JsonProcess
let credentials: JsonProcess
let automation: JsonProcess | undefined
let worker: Electron.UtilityProcess
let snapshot = emptySnapshot()
const pending = new Map<
  string,
  { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>()
let ready = false
let quitting = false
let shutdownComplete = false
let nativeAlive = false
let shortcut = ''
const profile = process.env.JARVIS_PROFILE
if (profile && !app.isPackaged) app.setPath('userData', profile)
app.setName('Jarvis')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => windows?.orb.showInactive())
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox('Jarvis could not start', safeError(error))
      app.quit()
    })
}

function emit(event: AppEvent) {
  windows?.broadcast(event)
}
function service<T = unknown>(command: unknown): Promise<T> {
  if (!ready) return Promise.reject(new Error('Jarvis is starting. Try again in a moment.'))
  const id = uid()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('The task service did not respond.'))
    }, 30_000)
    pending.set(id, { resolve, reject, timer })
    worker.postMessage({ version: 1, id, command })
  })
}
async function host(method: string, params: any) {
  if (
    method === 'native' &&
    (params.method.startsWith('browser.') || params.method.startsWith('apple.mail.'))
  ) {
    if (!automation) {
      const path = app.isPackaged
        ? join(process.resourcesPath, 'native/JarvisAutomation')
        : join(app.getAppPath(), 'native/build/JarvisAutomation')
      const helper = (automation = new JsonProcess(path, [], {
        env: { PATH: '/usr/bin:/bin', HOME: app.getPath('home') },
      }))
      helper.on('exit', () => {
        if (automation === helper) automation = undefined
      })
    }
    return automation.request(params.method, params.params, 25_000)
  }
  if (method === 'native')
    return native.request(params.method, params.params, params.timeout ?? 30_000)
  if (method === 'credential.get')
    return (await credentials.request('keychain.get', { account: params.account })).value
  if (method === 'credential.set') return credentials.request('keychain.set', params)
  if (method === 'credential.delete') return credentials.request('keychain.delete', params)
  if (method === 'open.external') {
    const url = new URL(params.url)
    const allowed = [
      'auth.openai.com',
      'chatgpt.com',
      'accounts.google.com',
      'console.anthropic.com',
    ]
    if (url.protocol !== 'https:' || !allowed.includes(url.hostname))
      throw new Error('This connection returned an untrusted sign-in address.')
    await shell.openExternal(url.href)
    return true
  }
  if (method === 'export') {
    const result = await dialog.showSaveDialog({
      defaultPath: params.filename,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, JSON.stringify(params.data, null, 2), { mode: 0o600 })
    return result.filePath
  }
  throw new Error('Unsupported host request.')
}
async function start() {
  const dataDir = app.getPath('userData')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  windows = new WindowCoordinator(root, emit)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Jarvis',
        submenu: [
          { label: 'Settings…', accelerator: 'Command+,', click: () => windows.openSettings() },
          { label: 'Show orb', click: () => windows.orb.showInactive() },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]),
  )
  installCommands()
  const nativePath = app.isPackaged
    ? join(process.resourcesPath, 'native/JarvisNative')
    : join(app.getAppPath(), 'native/build/JarvisNative')
  if (!existsSync(nativePath))
    throw new Error('The native helper is missing. Run pnpm native:build and restart Jarvis.')
  native = new JsonProcess(nativePath, [dataDir], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: app.getPath('home'), LANG: 'en_US.UTF-8' },
  })
  native.on('message', (message) => worker?.postMessage({ nativeEvent: message }))
  native.on('exit', () => {
    nativeAlive = false
    snapshot.diagnostics.native = false
    snapshot.diagnostics.workerErrors.push('The native helper stopped. Restart Jarvis to recover.')
    emit({ type: 'snapshot', snapshot })
  })
  const nativeInfo = await native.request('ping')
  nativeAlive = true
  credentials = new JsonProcess(join(dirname(nativePath), 'JarvisKeychain'), [], {
    env: { PATH: '/usr/bin:/bin', HOME: app.getPath('home') },
  })
  const keyAccount = `database-key-v1-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}`
  let key = (await credentials.request('keychain.get', { account: keyAccount })).value as
    string | null
  if (!key) {
    key = randomBytes(32).toString('base64')
    if (existsSync(join(dataDir, 'jarvis.db')))
      throw new Error(
        'This database has no matching Keychain key. Its contents are preserved. Restore the original credential before reopening it.',
      )
    await credentials.request('keychain.set', { account: keyAccount, value: key })
  }
  worker = utilityProcess.fork(join(root, 'service.js'), [], {
    serviceName: 'Jarvis Task Service',
    stdio: 'pipe',
    env: {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: app.getPath('home'),
      LANG: 'en_US.UTF-8',
    },
  })
  worker.on('message', async (message) => {
    if (message.shutdownComplete) {
      shutdownComplete = true
      native?.stop()
      credentials?.stop()
      app.quit()
      return
    }
    if (message.host) {
      try {
        worker.postMessage({
          hostResponse: message.id,
          result: await host(message.host, message.params),
        })
      } catch (error) {
        worker.postMessage({ hostResponse: message.id, error: safeError(error) })
      }
      return
    }
    if (message.event) {
      const event = message.event as AppEvent
      if (event.type === 'snapshot') {
        const previousApproval = snapshot.approvals[0]?.id
        snapshot = event.snapshot
        snapshot.diagnostics = {
          ...snapshot.diagnostics,
          glass: windows.glass,
          native: nativeAlive,
          platform: `macOS ${process.getSystemVersion()}`,
          chip: cpus()[0]?.model ?? 'Apple silicon',
          memoryGB: Math.round(totalmem() / 2 ** 30),
          appMemoryMB: Math.round(
            app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024,
          ),
        }
        windows.update(snapshot.settings)
        applySettings()
        if (snapshot.approvals[0] && snapshot.approvals[0].id !== previousApproval)
          windows.setForm('approval', false)
        if (!snapshot.approvals.length && windows.form === 'approval')
          windows.setForm('task', false)
      }
      if (
        event.type === 'notice' &&
        event.tone === 'error' &&
        windows.form === 'orb' &&
        !windows.settings?.isVisible()
      )
        windows.setForm('menu', false)
      emit(event)
      return
    }
    if (message.ready) {
      ready = true
      void service({ type: 'snapshot' })
      return
    }
    const request = pending.get(message.id)
    if (request) {
      clearTimeout(request.timer)
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.result)
    }
  })
  worker.on('exit', (code) => {
    ready = false
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('The task service stopped.'))
    }
    pending.clear()
    if (!quitting) {
      snapshot.diagnostics.workerErrors.push(
        `Task service exited (${code}). Restart to recover preserved tasks.`,
      )
      emit({ type: 'snapshot', snapshot })
    }
  })
  worker.stderr?.on('data', (chunk) => console.error(safeError(chunk.toString())))
  worker.postMessage({
    init: {
      dataDir,
      key,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
      nativeInfo,
    },
  })
  key = null
  setInterval(() => {
    if (snapshot.permissions.accessibility && ready)
      void native
        .request('context.focus')
        .then((rect) => windows.avoid(rect))
        .catch(() => {})
  }, 750).unref()
  powerMonitor.on('lock-screen', () => {
    snapshot.diagnostics.locked = true
    void service({ type: 'system.suspend' }).catch(() => {})
    emit({ type: 'snapshot', snapshot })
  })
  powerMonitor.on('unlock-screen', () => {
    snapshot.diagnostics.locked = false
    emit({ type: 'snapshot', snapshot })
    void service({ type: 'system.resume' }).catch(() => {})
  })
  powerMonitor.on('suspend', () => {
    void service({ type: 'system.suspend' }).catch(() => {})
  })
  powerMonitor.on('resume', () => {
    void service({ type: 'system.resume' }).catch(() => {})
  })
  app.dock?.hide()
}
function installCommands() {
  ipcMain.handle('jarvis:command', async (event, input): Promise<Result> => {
    try {
      if (
        !windows.all().some((w) => w.webContents === event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('Untrusted interface.')
      if (Buffer.byteLength(JSON.stringify(input)) > MAX_MESSAGE_BYTES)
        throw new Error('Request is too large.')
      const command = Command.parse(input)
      if (command.type === 'surface.ready') {
        windows.surfaceReady(event.sender.id)
        return { ok: true, value: true }
      }
      if (command.type === 'snapshot') return { ok: true, value: snapshot }
      if (command.type === 'settings.open') {
        windows.openSettings(command.section)
        return { ok: true, value: true }
      }
      if (command.type === 'overlay.form') {
        windows.setForm(command.form)
        return { ok: true, value: true }
      }
      if (command.type === 'overlay.drag') {
        windows.drag(command.phase, command.x, command.y)
        return { ok: true, value: true }
      }
      if (command.type === 'overlay.interaction') {
        windows.interaction(command.active)
        return { ok: true, value: true }
      }
      if (command.type === 'overlay.dock') {
        windows.dock(command.edge)
        return { ok: true, value: true }
      }
      if (command.type === 'app.quit') {
        app.quit()
        return { ok: true, value: true }
      }
      if (command.type === 'context.selectRegion') {
        if (snapshot.permissions.screen !== 'granted')
          throw new Error('Allow Screen Recording in Privacy & access before sharing an area.')
        windows.openSelection()
        return { ok: true, value: true }
      }
      if (command.type === 'context.cancelRegion') {
        windows.closeSelection()
        return { ok: true, value: true }
      }
      if (command.type === 'context.regionChosen') {
        const bounds = windows.selectionBounds(event.sender)
        if (!bounds) throw new Error('This selection is no longer active.')
        // Close first so the scrim is gone, then capture; the helper also excludes our windows.
        windows.closeSelection()
        try {
          await service({
            type: 'context.regionSelected',
            x: bounds.x + command.x,
            y: bounds.y + command.y,
            width: command.width,
            height: command.height,
          })
          windows.setForm('context', false)
        } catch (error) {
          // The window that asked is gone, so the answer has to reach the remaining surfaces.
          emit({ type: 'notice', tone: 'error', message: safeError(error) })
        }
        return { ok: true, value: true }
      }
      if (command.type === 'vault.choose') {
        const result = await dialog.showOpenDialog({
          title: 'Choose the folder that holds your notes',
          message: 'Jarvis indexes the Markdown notes inside it. The files stay where they are.',
          properties: ['openDirectory'],
        })
        if (result.canceled || !result.filePaths[0]) return { ok: true, value: null }
        return {
          ok: true,
          value: await service({ type: 'vault.selected', path: result.filePaths[0] }),
        }
      }
      if (command.type === 'project.add') {
        const result = await dialog.showOpenDialog({
          title: 'Choose a repository for Jarvis',
          properties: ['openDirectory'],
        })
        if (result.canceled || !result.filePaths[0]) return { ok: true, value: null }
        return {
          ok: true,
          value: await service({
            type: 'project.addSelected',
            path: result.filePaths[0],
            name: basename(result.filePaths[0]),
          }),
        }
      }
      return { ok: true, value: await service(command) }
    } catch (error) {
      return { ok: false, error: safeError(error) }
    }
  })
}

function applySettings() {
  if (shortcut !== snapshot.settings.shortcut) {
    if (shortcut) globalShortcut.unregister(shortcut)
    shortcut = snapshot.settings.shortcut
    try {
      snapshot.diagnostics.shortcutError = globalShortcut.register(shortcut, () => {
        void service({ type: 'voice.toggle' }).catch((error) =>
          emit({ type: 'notice', tone: 'error', message: safeError(error) }),
        )
      })
        ? undefined
        : 'That shortcut is already in use. Choose another in Settings.'
    } catch {
      snapshot.diagnostics.shortcutError = 'This keyboard shortcut is invalid.'
    }
  }
  if (app.isPackaged && app.getLoginItemSettings().openAtLogin !== snapshot.settings.startAtLogin)
    app.setLoginItemSettings({ openAtLogin: snapshot.settings.startAtLogin })
}
app.on('window-all-closed', () => {})
app.on('before-quit', (event) => {
  if (shutdownComplete) return
  if (ready) event.preventDefault()
  if (quitting) return
  quitting = true
  globalShortcut.unregisterAll()
  if (ready) {
    worker.postMessage({ shutdown: true })
    setTimeout(() => {
      shutdownComplete = true
      native?.stop()
      credentials?.stop()
      app.quit()
    }, 5000).unref()
  } else {
    native?.stop()
    credentials?.stop()
  }
})
app.on('will-quit', () => {
  automation?.stop()
  credentials?.stop()
  native?.stop()
  worker?.kill()
})
