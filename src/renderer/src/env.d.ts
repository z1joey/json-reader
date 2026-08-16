/// <reference types="vite/client" />
import type { JsonReaderApi } from '../../shared/types'

declare global {
  interface Window {
    jsonReader: JsonReaderApi
  }
}

export {}
