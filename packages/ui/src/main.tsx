import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { VsCodeTransport } from './transport.js'

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Light Code: could not find #root element to mount into.')
}

// CSSOM property assignment, not the `style` attribute — not subject to CSP style-src.
document.documentElement.style.height = '100%'
document.body.style.height = '100%'
document.body.style.margin = '0'

createRoot(rootElement).render(<App transport={new VsCodeTransport()} />)
