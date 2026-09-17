import { App } from '@light-code/ui'
import { createRoot } from 'react-dom/client'
import { HttpTransport, type StatusLevel } from './transport.js'

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Light Code: no #root element to mount into.')

const status = document.getElementById('status')
const setStatus = (text: string, level: StatusLevel = 'error'): void => {
  if (status === null) return
  /*
   * Hidden when all is well: a permanent banner reading "connected" is noise.
   *
   * The level decides the colour, rather than the text being compared to a magic string. It used
   * to be `text === 'connected'`, with one error style for everything else — so the polling
   * fallback, which is a *working* state, announced itself in red and was reported as a fault.
   * Degraded and broken must not look the same.
   */
  status.textContent = level === 'ok' ? '' : text
  status.style.display = level === 'ok' ? 'none' : 'block'
  status.className = level
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

/**
 * Takes the starting screen down once the panel has what it needs.
 *
 * `settings` is the signal, because it is the reply the panel is built from — the one carrying
 * the theme, the mode and the approvals. Waiting for it rather than for the connection means the
 * chat appears furnished rather than empty and then filling in.
 *
 * **It always comes down**, on a timer as well, and that is deliberate: a starting screen that
 * can get stuck is worse than none at all, because the product becomes unreachable rather than
 * merely unfurnished. If the state never arrives the user gets the panel plus whatever the status
 * banner says about why, which they can act on.
 */
const booting = document.getElementById('booting')
const bootingDetail = document.getElementById('booting-detail')
const finishBooting = (): void => booting?.classList.add('done')
const BOOTING_GIVE_UP_MS = 10_000
const bootingTimer = setTimeout(finishBooting, BOOTING_GIVE_UP_MS)

const transport = new HttpTransport((text, level) => {
  setStatus(text, level)
  // The banner is the honest detail line while starting: it is already saying what is happening.
  if (bootingDetail !== null && level !== 'ok') bootingDetail.textContent = text
})
transport.onMessage((message) => {
  const settings = message as { type?: string; theme?: string }
  if (settings.type !== 'settings') return
  applyTheme(settings.theme)
  clearTimeout(bootingTimer)
  finishBooting()
})

transport
  .connect()
  .then(() => createRoot(rootElement).render(<App transport={transport} />))
  .catch((error: unknown) => {
    // Nothing further is coming, so the screen must not sit there: show the panel and the reason.
    clearTimeout(bootingTimer)
    finishBooting()
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  })
