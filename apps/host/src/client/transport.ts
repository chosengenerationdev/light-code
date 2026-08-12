import type { Transport } from '@light-code/core/browser'

/**
 * The browser half of `Transport`: an SSE stream inbound, POSTs outbound.
 *
 * Chosen over a WebSocket deliberately. A WebSocket upgrade is **not** subject to CORS, so
 * origin enforcement has to be hand-written in the upgrade handler and a mistake there is
 * silent (§14). Two ordinary HTTP requests get the browser's own origin rules for free,
 * and the server still checks `Origin` and `Host` on both.
 *
 * `EventSource` is not used, because it cannot set an `Authorization` header — the token
 * would have to go in the query string, which is exactly what §14's two-stage handoff
 * exists to avoid. A streamed `fetch` can set headers.
 */
export class HttpTransport implements Transport {
  private readonly listeners = new Set<(message: unknown) => void>()
  private token: string | undefined

  constructor(private readonly onStatus: (status: string) => void) {}

  /**
   * Exchanges the launch fragment for a session token, then strips it from the address bar.
   *
   * The fragment is never sent to the server by the browser, which is what makes it a
   * usable one-time channel — but it does persist in history, hence `replaceState`.
   */
  async connect(): Promise<void> {
    const handoff = new URLSearchParams(window.location.hash.slice(1)).get('t')
    if (handoff !== null) {
      window.history.replaceState(null, '', window.location.pathname)
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoff }),
      })
      if (!response.ok) throw new Error(await response.text())
      this.token = ((await response.json()) as { token: string }).token
      sessionStorage.setItem('lightCodeToken', this.token)
    } else {
      // A reload has no fragment left. sessionStorage is per-tab and cleared when it
      // closes, which matches the lifetime of the session this token belongs to.
      this.token = sessionStorage.getItem('lightCodeToken') ?? undefined
    }
    if (this.token === undefined) throw new Error('No session. Restart light-code and open the printed URL.')
    void this.listen()
  }

  private async listen(): Promise<void> {
    for (;;) {
      try {
        const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${this.token ?? ''}` } })
        if (!response.ok || response.body === null) throw new Error(`stream failed: ${response.status}`)
        this.onStatus('connected')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // Events are `\n\n`-terminated; a chunk can split one, so only complete frames
          // are consumed and the remainder stays buffered.
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            if (frame.startsWith('data: ')) {
              const message: unknown = JSON.parse(frame.slice(6))
              for (const listener of this.listeners) listener(message)
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        this.onStatus(`disconnected — retrying (${error instanceof Error ? error.message : String(error)})`)
      }
      // The server going away during a restart is the common case, so reconnect rather
      // than leaving a dead page. Fixed delay: this is loopback, not a busy backend.
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  post(message: unknown): void {
    void fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token ?? ''}` },
      body: JSON.stringify(message),
    }).catch(() => this.onStatus('send failed — is the server still running?'))
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
