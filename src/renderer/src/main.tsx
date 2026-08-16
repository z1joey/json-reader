import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

if (navigator.platform.startsWith('Mac')) {
  document.documentElement.classList.add('mac')
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
