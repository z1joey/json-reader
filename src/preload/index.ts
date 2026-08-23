import { contextBridge, ipcRenderer } from 'electron'
import type { JsonReaderApi } from '../shared/types'

const api: JsonReaderApi = {
  openFolder: () => ipcRenderer.invoke('json:open-folder'),
  openFile: (index: number) => ipcRenderer.invoke('json:open-file', index),
  getItem: (index: number) => ipcRenderer.invoke('json:get-item', index),
  search: (query: string) => ipcRenderer.invoke('json:search', query),
  onOpenFolderRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('open-folder-requested', listener)
    return () => ipcRenderer.removeListener('open-folder-requested', listener)
  }
}

contextBridge.exposeInMainWorld('jsonReader', api)
