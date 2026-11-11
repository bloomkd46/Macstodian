import { contextBridge, ipcRenderer } from 'electron'
import type { MacstodianAPI, ScanProgress } from '../shared/api'

const api: MacstodianAPI = {
  scan: () => ipcRenderer.invoke('storage:scan'),
  getAppIcons: (appIds) => ipcRenderer.invoke('storage:app-icons', appIds),
  onProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ScanProgress) =>
      callback(progress)
    ipcRenderer.on('storage:progress', listener)
    return () => {
      ipcRenderer.removeListener('storage:progress', listener)
    }
  },
  review: (request) => ipcRenderer.invoke('storage:review', request),
  confirm: (planId) => ipcRenderer.invoke('storage:confirm', planId),
  reveal: (request) => ipcRenderer.invoke('storage:reveal', request)
}
contextBridge.exposeInMainWorld('macstodian', api)
