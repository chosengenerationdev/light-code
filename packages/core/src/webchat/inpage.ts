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
export function watchScript(origin: string, marker: string | undefined): string {
  return `async () => {
  const ORIGIN = ${JSON.stringify(origin)}
  if (location.origin !== ORIGIN) return { ok: false, error: 'The selected page is ' + location.origin + ', not the web chat.' }
  const w = window
  w.__lcWebChat = w.__lcWebChat || { found: [], headers: {}, ws: false, marker: undefined }
  const state = w.__lcWebChat
  ${marker !== undefined ? `state.marker = ${JSON.stringify(marker)}; state.found = []; state.ws = false` : ''}
  if (state.installed) return { ok: true }
  state.installed = true
  const secret = /^(authorization|proxy-authorization|x-csrf-token|x-xsrf-token|csrf-token|x-auth-token|x-api-key|api-key|x-access-token|x-id-token)$|token|secret|session|auth/i
  const note = (url, headers) => {
    try { if (new URL(url, location.href).origin !== ORIGIN) return } catch { return }
    for (const [k, v] of Object.entries(headers)) if (secret.test(k)) state.headers[k.toLowerCase()] = v
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
    if (body === undefined && input instanceof Request) { try { body = await input.clone().text() } catch {} }
    note(url, headers)
    const response = await origFetch.apply(this, arguments)
    if (state.marker && body && body.includes(state.marker)) {
      const entry = { url: new URL(url, location.href).href, method: method.toUpperCase(), headers, body, status: response.status, contentType: response.headers.get('content-type') || '' }
      state.found.push(entry)
      response.clone().text().then((t) => { entry.response = t.slice(0, 2000000) }).catch(() => {})
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
        const entry = { url: info.url, method: info.method, headers: info.headers, body }
        state.found.push(entry)
        this.addEventListener('loadend', () => { entry.status = this.status; entry.contentType = this.getResponseHeader('content-type') || ''; entry.response = String(this.responseText || '').slice(0, 2000000) })
      }
    }
    return send.apply(this, arguments)
  }
  const wsSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) { if (state.marker && typeof data === 'string' && data.includes(state.marker)) state.ws = true; return wsSend.apply(this, arguments) }
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
  const url = new URL(${JSON.stringify(setup.request.path)}, ORIGIN)
  if (url.origin !== ORIGIN) return { ok: false, error: 'The saved backend address is not on the web chat site; nothing was sent.' }
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
    response = await fetch(url.href, { method: ${JSON.stringify(setup.request.method)}, headers, body: ${JSON.stringify(fillBody(setup, question))}, credentials: 'include', redirect: 'error' })
  } catch (e) {
    return { ok: false, error: 'The request failed in the page: ' + (e && e.message ? e.message : String(e)) }
  }
  if (response.url && new URL(response.url).origin !== ORIGIN) return { ok: false, error: 'The reply came from another site; it was not used.' }
  const text = await response.text()
  return { ok: true, status: response.status, contentType: response.headers.get('content-type') || '', text: text.slice(0, 2000000) }
}`
}

/** Types the capture phrase into the chat's message box and sends it - the optional "Send it for me". */
export function typePhraseScript(origin: string, marker: string): string {
  return `async () => {
  if (location.origin !== ${JSON.stringify(origin)}) return { ok: false, error: 'The selected page is ' + location.origin + ', not the web chat.' }
  const visible = (el) => el.offsetParent !== null
  const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')].filter(visible)
  const box = boxes.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
  if (!box) return { ok: false, error: 'No message box found on the page - paste the phrase by hand.' }
  box.focus()
  const text = ${JSON.stringify(marker)}
  if (box.isContentEditable) { document.execCommand('insertText', false, text) }
  else {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')?.set
    if (setter) setter.call(box, text); else box.value = text
    box.dispatchEvent(new Event('input', { bubbles: true }))
  }
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
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
