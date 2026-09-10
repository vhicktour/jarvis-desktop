import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, Command, JarvisAPI, Result } from '../shared/contracts'
const api: JarvisAPI = {
  surface: process.argv.includes('--jarvis-surface=settings') ? 'settings' : 'overlay',
  async command<T>(command: Command): Promise<T> {
    const result = (await ipcRenderer.invoke('jarvis:command', command)) as Result<T>
    if (!result.ok) throw new Error(result.error)
    return result.value
  },
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value)
    ipcRenderer.on('jarvis:event', receive)
    return () => ipcRenderer.removeListener('jarvis:event', receive)
  },
}
contextBridge.exposeInMainWorld('jarvis', Object.freeze(api))
