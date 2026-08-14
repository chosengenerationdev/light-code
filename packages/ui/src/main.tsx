import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { applyAccent, DEFAULT_ACCENT, installStyles } from './styles.js'
import { VsCodeTransport } from './transport.js'

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Light Code: could not find #root element to mount into.')
}

// CSSOM property assignment, not the `style` attribute — not subject to CSP style-src.
document.documentElement.style.height = '100%'
document.body.style.height = '100%'
document.body.style.margin = '0'

/*
 * Both are CSSOM too — see styles.ts for why that matters. The accent is applied before the
 * first render with the default, then again from config once the bridge answers; without the
 * first call the panel paints one frame with no accent, which reads as a flash.
 */
installStyles()
applyAccent(DEFAULT_ACCENT)

createRoot(rootElement).render(<App transport={new VsCodeTransport()} />)
