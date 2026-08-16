import { contextBridge, ipcRenderer } from 'electron'
import type { JsonReaderApi } from '../shared/types'

const api: JsonReaderApi = {
  open: () => ipcRenderer.invoke('json:open'),
  getItem: (index: number) => ipcRenderer.invoke('json:get-item', index),
  onOpenRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('open-json-requested', listener)
    return () => ipcRenderer.removeListener('open-json-requested', listener)
  }
}

contextBridge.exposeInMainWorld('jsonReader', api)
