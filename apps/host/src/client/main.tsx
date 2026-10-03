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
 * Takes the starting screen down once the panel has everything it is built from.
 *
 * ## Why more than one reply
 *
 * It waited for `settings` alone, and was reported gone while the saved providers still were not
 * there — which is the exact thing it was added to prevent. `settings` carries the theme, the mode
 * and the approvals; the provider list is a *separate* reply, and the chat header cannot render a
 * model selector without it. Showing the chat between the two is showing an unfinished panel, so
 * both are waited for.
 *
 * Named rather than counted, so adding a third is a deliberate line here rather than a number
 * somebody has to work out the meaning of.
 *
 * ## Why it always comes down anyway
 *
 * A starting screen that can stick makes the product unreachable, which is worse than one that
 * lifts early: at least then you can see the panel and whatever the banner says about why it is
 * empty. So the timer stays, and it is the backstop for a reply that never arrives at all.
 */
const booting = document.getElementById('booting')
const bootingDetail = document.getElementById('booting-detail')
const finishBooting = (): void => booting?.classList.add('done')
const BOOTING_GIVE_UP_MS = 10_000
const bootingTimer = setTimeout(finishBooting, BOOTING_GIVE_UP_MS)

/** Every reply the panel needs before it is worth showing. Emptied as each arrives. */
const awaiting = new Set(['settings', 'profiles'])

const transport = new HttpTransport((text, level) => {
  setStatus(text, level)
  // The banner is the honest detail line while starting: it is already saying what is happening.
  if (bootingDetail !== null && level !== 'ok') bootingDetail.textContent = text
})
/**
 * Tells Light Code Sun, when this page is one of its panes, what the agent is doing.
 *
 * Sun shows a dot per codebase — working, waiting for you, finished — and only puts an idle
 * codebase to sleep. It cannot see inside the frame, so the page says. Only a state word crosses:
 * never text, never a path. Sent to the embedding origin alone, which the CSP's `frame-ancestors`
 * has already restricted to what the operator allowed.
 */
const embedder = ((): string | undefined => {
  if (window.parent === window) return undefined
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins
  return ancestors !== undefined && ancestors.length > 0 ? ancestors[0] : undefined
})()
let agentState: 'idle' | 'busy' | 'attention' = 'idle'
const reportState = (next: typeof agentState, finished = false): void => {
  if (embedder === undefined || (next === agentState && !finished)) return
  agentState = next
  window.parent.postMessage({ source: 'light-code', state: next, finished }, embedder)
}
/*
 * Sun's own shortcuts, passed up. Keystrokes in a frame never reach the page around it, and focus
 * is almost always here, in the composer — so without this Ctrl+B and Ctrl+K would work only after
 * clicking the sidebar. Only these combinations, which the chat itself does not use. Ctrl+T and
 * Ctrl+W open and close a chat tab.
 */
if (embedder !== undefined) {
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      const key = event.key.toLowerCase()
      const shortcut =
        key === 'b' || key === 'k' || key === 'n' || key === 't' || key === 'w' || key === ',' || /^[1-9]$/.test(key) || key === 'tab'
          ? `${event.shiftKey ? 'shift+' : ''}${key}`
          : undefined
      if (shortcut === undefined) return
      event.preventDefault()
      window.parent.postMessage({ source: 'light-code', shortcut }, embedder)
    },
    true,
  )
}

/*
 * Sun's theme and accent colour, which every pane follows while it runs there.
 *
 * Applied by rewriting the `settings` message on its way in rather than by saving anything: the
 * config may be linked to the VS Code extension's, and a window's appearance has no business
 * changing that file. The panel is told who sets them (`appearanceFrom`) so it names Sun instead
 * of offering a picker whose choice would be overridden. Role colours are left alone.
 */
let sunAppearance: { theme: 'system' | 'light' | 'dark'; accent: string; own: boolean } | undefined
let lastSettings: unknown
if (embedder !== undefined) {
  transport.setIncomingFilter((message) => {
    const incoming = message as { type?: string } | null
    if (incoming?.type !== 'settings') return message
    lastSettings = message
    if (sunAppearance === undefined) return message
    return {
      ...incoming,
      choosesTheme: false,
      theme: sunAppearance.theme,
      accentColor: sunAppearance.accent,
      appearanceFrom: 'Sun Light Code',
      accentInherited: !sunAppearance.own,
    }
  })
  /*
   * An accent picked in this panel is this codebase's own, and Sun keeps it - not the config file,
   * which may be the VS Code extension's and would then change VS Code's accent too.
   */
  transport.setOutgoingFilter((message) => {
    const outgoing = message as { type?: string; value?: unknown } | null
    if (outgoing?.type === 'setAccentColor' && typeof outgoing.value === 'string') {
      window.parent.postMessage({ source: 'light-code', accent: outgoing.value }, embedder)
      return true
    }
    if (outgoing?.type === 'inheritAccentColor') {
      window.parent.postMessage({ source: 'light-code', accent: null }, embedder)
      return true
    }
    return false
  })
  window.addEventListener('message', (event) => {
    if (event.origin !== embedder || event.source !== window.parent) return
    const data = event.data as { source?: string; appearance?: { theme?: unknown; accent?: unknown; own?: unknown } } | null
    if (data?.source !== 'sun' || data.appearance === undefined) return
    const { theme, accent } = data.appearance
    if ((theme !== 'system' && theme !== 'light' && theme !== 'dark') || typeof accent !== 'string') return
    if (!/^#[0-9a-f]{6}$/i.test(accent)) return
    sunAppearance = { theme, accent, own: data.appearance.own === true }
    applyTheme(theme)
    if (lastSettings !== undefined) transport.redeliver(lastSettings)
  })
  // Asks for the appearance at once, so it is in hand before the first settings reply arrives.
  window.parent.postMessage({ source: 'light-code', ready: true }, embedder)
}

const BUSY_MESSAGES = new Set(['textChunk', 'reasoningChunk', 'toolCall', 'toolResult', 'chart', 'diagram'])

transport.onMessage((message) => {
  const incoming = message as { type?: string; theme?: string }
  if (incoming.type !== undefined) {
    if (BUSY_MESSAGES.has(incoming.type)) reportState('busy')
    else if (incoming.type === 'approvalRequest' || incoming.type === 'formRequest') reportState('attention')
    else if (incoming.type === 'done' || incoming.type === 'error') reportState('idle', agentState !== 'idle')
  }
  if (incoming.type === 'settings') applyTheme(incoming.theme)
  if (incoming.type === undefined || !awaiting.delete(incoming.type)) return

  if (bootingDetail !== null && awaiting.size > 0) {
    // Says what is still outstanding rather than sitting on one sentence for the whole wait.
    bootingDetail.textContent = `waiting for ${[...awaiting].join(', ')}`
  }
  if (awaiting.size === 0) {
    clearTimeout(bootingTimer)
    finishBooting()
  }
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
