import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root container #root is missing from index.html')
}

// A preload failure would otherwise render an app whose every button silently
// does nothing, so fail loudly instead.
if (typeof window.api === 'undefined') {
  container.innerHTML =
    '<div style="padding:32px;font:13px/1.6 system-ui;color:#e8e8ee;background:#0b0b0f;height:100%">' +
    '<h1 style="font-size:15px;margin:0 0 8px">Bridge unavailable</h1>' +
    '<p style="margin:0;color:#9a9aa8">The preload script did not expose <code>window.api</code>. ' +
    'Rebuild with <code>npm run build</code> and make sure <code>dist/preload/index.js</code> exists.</p>' +
    '</div>'
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
