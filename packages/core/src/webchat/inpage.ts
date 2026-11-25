import { fillBody, type WebChatSetup } from './setup.js'

/**
 * The JavaScript `ask_web_chat` runs inside the chat page, through the Chrome DevTools MCP server's `evaluate_script`.
 * Each is a complete function as text, with every value written in as a JSON literal - nothing a model wrote is ever
 * pasted into code.
 *
 * In the page, as the page: the request carries the user's session from the browser, and no credential reaches Light
 * Code. Every function first checks it is on the expected site, and the request is made to that site only, with
 * redirects refused (rule 5 in guard.ts).
 */

/**
 * Watches the page's own requests: records any whose body holds the capture phrase (with its reply), and remembers the
 * latest value of each credential-like header the page sends, so a replay can take it from the page instead of storing
 * it. Installed once per page; installing again changes only the phrase looked for.
 */
export function watchScript(origin: string, marker: string | undefined, backendUrl?: string): string {
  return `async () => {
  const ORIGIN = ${JSON.stringify(origin)}
  if (location.origin !== ORIGIN) return { ok: false, error: 'The selected page is ' + location.origin + ', not the web chat.' }
  const w = window
  w.__lcWebChat = w.__lcWebChat || { found: [], headers: {}, ws: false, marker: undefined, replies: [] }
  const state = w.__lcWebChat
  state.replies = state.replies || []
  ${backendUrl !== undefined ? `state.watchUrl = ${JSON.stringify(backendUrl)}; state.replies = []; state.ws = false` : ''}
  ${marker !== undefined ? `state.marker = ${JSON.stringify(marker)}; state.found = []; state.ws = false` : ''}
  if (state.installed) return { ok: true }
  state.installed = true
  const secret = /^(authorization|proxy-authorization|x-csrf-token|x-xsrf-token|csrf-token|x-auth-token|x-api-key|api-key|x-access-token|x-id-token)$|token|secret|session|auth/i
  // The chat window method: the page's own requests to the approved backend, with their replies, wherever it is.
  const toBackend = (u) => {
    if (!state.watchUrl) return false
    // Same site, same path segment by segment - except a segment that is plainly an id (a long number, long hex, a UUID),
    // which a chat app changes per conversation.
    const id = (x) => /^\\d{3,}$/.test(x) || /^[0-9a-f]{12,}$/i.test(x) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
    try {
      const a = new URL(u, location.href), b = new URL(state.watchUrl)
      if (a.origin !== b.origin) return false
      const p = a.pathname.split('/'), q = b.pathname.split('/')
      return p.length === q.length && p.every((part, i) => part === q[i] || (id(part) && id(q[i])))
    } catch { return false }
  }
  // The page's sign-in headers, from its requests to its own site or to the approved backend (which may be another site).
  const keep = (headers) => { for (const [k, v] of Object.entries(headers)) if (secret.test(k)) state.headers[k.toLowerCase()] = v }
  const note = (url, headers) => {
    try { if (new URL(url, location.href).origin !== ORIGIN && !toBackend(url)) return } catch { return }
    keep(headers)
  }
  const plain = (h) => {
    const out = {}
    if (!h) return out
    if (h instanceof Headers) { h.forEach((v, k) => { out[k] = v }); return out }
    if (Array.isArray(h)) { for (const [k, v] of h) out[k] = v; return out }
    for (const [k, v] of Object.entries(h)) out[k] = String(v)
    return out
  }
  const origFetch = w.fetch
  w.fetch = async function (input, init) {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let method = (init && init.method) || (input instanceof Request ? input.method : 'GET')
    let headers = plain((init && init.headers) || (input instanceof Request ? input.headers : undefined))
    let body = init && typeof init.body === 'string' ? init.body : undefined
    const credentials = (init && init.credentials) || (input instanceof Request ? input.credentials : 'same-origin')
    if (body === undefined && input instanceof Request) { try { body = await input.clone().text() } catch {} }
    note(url, headers)
    const response = await origFetch.apply(this, arguments)
    if (state.marker && body && body.includes(state.marker)) {
      const entry = { url: new URL(url, location.href).href, method: method.toUpperCase(), headers, body, credentials, status: response.status, contentType: response.headers.get('content-type') || '' }
      state.found.push(entry)
      keep(headers)
      response.clone().text().then((t) => { entry.response = t.slice(0, 2000000) }).catch(() => {})
    }
    if (toBackend(url)) {
      const reply = { url: new URL(url, location.href).href, status: response.status, contentType: response.headers.get('content-type') || '', at: Date.now() }
      state.replies.push(reply)
      response.clone().text().then((t) => { reply.response = t.slice(0, 2000000) }).catch(() => { reply.response = '' })
    }
    return response
  }
  const X = XMLHttpRequest.prototype
  const open = X.open, setHeader = X.setRequestHeader, send = X.send
  X.open = function (method, url) { this.__lc = { method: String(method).toUpperCase(), url: new URL(url, location.href).href, headers: {} }; return open.apply(this, arguments) }
  X.setRequestHeader = function (k, v) { if (this.__lc) this.__lc.headers[k] = v; return setHeader.apply(this, arguments) }
  X.send = function (body) {
    const info = this.__lc
    if (info) {
      note(info.url, info.headers)
      if (state.marker && typeof body === 'string' && body.includes(state.marker)) {
        const entry = { url: info.url, method: info.method, headers: info.headers, body, credentials: this.withCredentials ? 'include' : 'same-origin' }
        state.found.push(entry)
        keep(info.headers)
        this.addEventListener('loadend', () => { entry.status = this.status; entry.contentType = this.getResponseHeader('content-type') || ''; entry.response = String(this.responseText || '').slice(0, 2000000) })
      }
      if (toBackend(info.url)) {
        const reply = { url: info.url, at: Date.now() }
        state.replies.push(reply)
        this.addEventListener('loadend', () => { reply.status = this.status; reply.contentType = this.getResponseHeader('content-type') || ''; reply.response = String(this.responseText || '').slice(0, 2000000) })
      }
    }
    return send.apply(this, arguments)
  }
  const wsSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) { if (state.marker && typeof data === 'string' && data.includes(state.marker)) state.ws = true; if (state.watchUrl) state.wsSent = true; return wsSend.apply(this, arguments) }
  return { ok: true }
}`
}

/** What the watcher has seen of the capture phrase: the requests that carried it, and whether a WebSocket did. */
export function readCaptureScript(origin: string): string {
  return `async () => {
  if (location.origin !== ${JSON.stringify(origin)}) return { ok: false, error: 'The selected page is ' + location.origin + ', not the web chat.' }
  const state = window.__lcWebChat
  if (!state) return { ok: true, found: [], ws: false, installed: false }
  return { ok: true, found: state.found.filter((e) => e.response !== undefined), pending: state.found.filter((e) => e.response === undefined).length, ws: state.ws, installed: true }
}`
}

/**
 * One consultation: the captured request, the question written in, sent from the page to the approved backend address
 * only. A credential header the page sends is taken from its latest request; with none seen yet, it says so rather
 * than sending without.
 */
export function askScript(setup: WebChatSetup, question: string): string {
  const origin = new URL(setup.pageUrl).origin
  return `async () => {
  const ORIGIN = ${JSON.stringify(origin)}
  if (location.origin !== ORIGIN) return { ok: false, error: 'The selected page is ' + location.origin + ', not the web chat.' }
  // The exact backend address the user approved - on the chat page's site or another (an api. address) - and no other.
  const url = new URL(${JSON.stringify(setup.backendUrl ?? new URL(setup.request.path, origin).href)})
  ${setup.backendUrl === undefined ? "if (url.origin !== ORIGIN) return { ok: false, error: 'The saved backend address is not on the web chat site; nothing was sent.' }" : ''}
  const state = window.__lcWebChat || { headers: {} }
  const headers = Object.assign({}, ${JSON.stringify(setup.request.headers)})
  const missing = []
  for (const name of ${JSON.stringify(setup.request.fromPage)}) {
    if (state.headers[name] !== undefined) headers[name] = state.headers[name]
    else missing.push(name)
  }
  if (missing.length > 0) return { ok: false, needsActivity: missing }
  let response
  try {
    // Cookies or not, as the page's own request did: a cross-site API answers its page's way and no other.
    response = await fetch(url.href, { method: ${JSON.stringify(setup.request.method)}, headers, body: ${JSON.stringify(fillBody(setup, question))}, credentials: ${JSON.stringify(setup.request.credentials ?? 'include')}, redirect: 'error' })
  } catch (e) {
    return { ok: false, error: 'The request failed in the page: ' + (e && e.message ? e.message : String(e)) }
  }
  if (response.url && new URL(response.url).origin !== url.origin) return { ok: false, error: 'The reply came from another site than the approved backend; it was not used.' }
  const text = await response.text()
  return { ok: true, status: response.status, contentType: response.headers.get('content-type') || '', text: text.slice(0, 2000000) }
}`
}

/** Types the capture phrase into the chat's message box and sends it - the optional "Send it for me". */
export function typePhraseScript(origin: string, marker: string): string {
  return typeTextScript(origin, marker)
}

/**
 * Types text into the chat's message box and sends it, as a person would: Enter, and when the text is still in the box
 * afterwards (an app that sends on its button only), the Send button beside it. The chat window method's way in.
 */
export function typeTextScript(origin: string, text: string): string {
  return `async () => {
  if (location.origin !== ${JSON.stringify(origin)}) return { ok: false, error: 'The selected page is ' + location.origin + ', not the web chat.' }
  const visible = (el) => el.offsetParent !== null
  const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')].filter(visible)
  const box = boxes.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
  if (!box) return { ok: false, error: 'No message box found on the page - paste the phrase by hand.' }
  box.focus()
  const text = ${JSON.stringify(text)}
  if (box.isContentEditable) { document.execCommand('selectAll', false); document.execCommand('insertText', false, text) }
  else {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')?.set
    if (setter) setter.call(box, text); else box.value = text
    box.dispatchEvent(new Event('input', { bubbles: true }))
  }
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  await new Promise((r) => setTimeout(r, 400))
  const still = box.isContentEditable ? (box.innerText || '').trim().length > 0 : String(box.value || '').trim().length > 0
  if (still) {
    let scope = box.parentElement
    let button
    for (let i = 0; i < 6 && scope && !button; i += 1, scope = scope.parentElement) {
      const buttons = [...scope.querySelectorAll('button, [role="button"], input[type="submit"]')].filter((b) => b.offsetParent !== null && !b.disabled)
      button = buttons.find((b) => /send|submit|ask/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '') + ' ' + (b.type || ''))) || (buttons.length === 1 ? buttons[0] : undefined)
    }
    // An app that keeps the text after sending looks the same as one that did not send: without a button to press, carry
    // on - the wait for the reply (or for the capture) says whether it went.
    if (button) button.click()
  }
  return { ok: true }
}`
}

/** The value a successful `evaluate_script` returned, from its text output (a fenced JSON block, or the bare JSON). */
export function scriptResult(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

/** The page's own replies to the approved backend since the watch began (chat window method). */
export function readRepliesScript(origin: string): string {
  return `async () => {
  if (location.origin !== ${JSON.stringify(origin)}) return { ok: false, error: 'The selected page is ' + location.origin + ', not the web chat.' }
  const state = window.__lcWebChat
  if (!state) return { ok: true, replies: [], pending: 0, ws: false }
  const replies = state.replies || []
  return { ok: true, replies: replies.filter((r) => r.response !== undefined), pending: replies.filter((r) => r.response === undefined).length, ws: state.wsSent === true }
}`
}

/** The page's visible text, for reading a reply off the screen when no request to the backend was seen. */
export function pageTextScript(origin: string): string {
  return `async () => {
  if (location.origin !== ${JSON.stringify(origin)}) return { ok: false, error: 'The selected page is ' + location.origin + ', not the web chat.' }
  return { ok: true, text: String(document.body ? document.body.innerText : '').slice(0, 400000) }
}`
}
