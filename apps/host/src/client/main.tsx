import { App } from '@light-code/ui'
import { createRoot } from 'react-dom/client'
import { HttpTransport } from './transport.js'

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Light Code: no #root element to mount into.')

const status = document.getElementById('status')
const setStatus = (text: string): void => {
  if (status === null) return
  // Hidden once connected: a permanent banner reading "connected" is noise, and the only
  // state worth interrupting for is the one where nothing is going to work.
  status.textContent = text === 'connected' ? '' : text
  status.style.display = text === 'connected' ? 'none' : 'block'
}

/*
 * The theme is applied here, from the settings message, before React renders anything it can.
 *
 * `prefers-color-scheme` follows the *browser's* appearance setting rather than the operating
 * system's, so a corporate Edge pinned to light shows a light UI on a dark Windows with no way
 * to change it. An explicit choice overrides that; "system" removes the attribute and hands the
 * decision back to the browser.
 *
 * Mirrored into localStorage so a reload paints correctly on the first frame instead of
 * flashing light while the socket connects — the flash is small and it looks like a bug.
 */
const applyTheme = (theme: string | undefined): void => {
  const root = document.documentElement
  if (theme === 'light' || theme === 'dark') {
    root.dataset.theme = theme
    try {
      localStorage.setItem('lightcode.theme', theme)
    } catch {
      // A browser with storage blocked still themes correctly, one frame later.
    }
  } else {
    delete root.dataset.theme
    try {
      localStorage.removeItem('lightcode.theme')
    } catch {
      /* as above */
    }
  }
}

try {
  applyTheme(localStorage.getItem('lightcode.theme') ?? undefined)
} catch {
  // Private windows and locked-down policies both throw here. Not a reason to fail to start.
}

const transport = new HttpTransport(setStatus)
transport.onMessage((message) => {
  const settings = message as { type?: string; theme?: string }
  if (settings.type === 'settings') applyTheme(settings.theme)
})

transport
  .connect()
  .then(() => createRoot(rootElement).render(<App transport={transport} />))
  .catch((error: unknown) => {
    setStatus(error instanceof Error ? error.message : String(error))
  })
