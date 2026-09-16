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
/** How many times a message is resent before the failure is reported instead. */
/**
 * How long to wait for the event stream before giving up on it and fetching replies instead.
 *
 * An ordinary connection opens the stream in milliseconds. Eight seconds is not a slow network,
 * it is a network that will not carry one.
 */
const STREAM_PATIENCE_MS = 8_000

/**
 * How often to ask for what is waiting, once polling — fast while something is happening, slow
 * when nothing is.
 *
 * A fixed second is the wrong answer in both directions. Streamed text arriving in one-second
 * blocks reads as a stutter rather than as typing; and an idle page asking once a second for ever
 * is a request every second for nothing, all day, per open tab.
 *
 * So the interval follows the conversation: anything arriving or being sent resets it to the fast
 * rate, and it eases back towards the slow one while the page is quiet. The user is watching
 * exactly when it is fast.
 */
const POLL_FAST_MS = 300
const POLL_IDLE_MS = 2_000
/** How long after the last activity the fast rate is kept. */
const POLL_ACTIVE_WINDOW_MS = 4_000

/** How many polls in a row may fail before the user is told. See `notePollFailure`. */
const POLL_FAILURES_BEFORE_REPORTING = 5

/**
 * Where this page's API lives, worked out from where the page itself came from.
 *
 * Reported from a JupyterHub server: the app is reached through `jupyter-server-proxy`, which
 * exposes a local port under `/user/<id>/proxy/<port>/`. A root-absolute request — `/api/events` —
 * does not belong to the app at all there; it belongs to the *hub*, and whether it arrives depends
 * entirely on how the proxy in front happens to be configured.
 *
 * Asking relative to `document.baseURI` removes the question. The proxy strips its own prefix
 * before forwarding, so `<prefix>/api/events` arrives here as `/api/events`, which is what this
 * server already serves. At the root it resolves to the same URLs as before, so nothing changes
 * for anybody running it locally.
 *
 * `new URL('.', …)` gives the directory: `/user/x/proxy/8080/admin` and `/user/x/proxy/8080/` both
 * yield `/user/x/proxy/8080/`, which is the base those two pages share.
 */
function apiBase(): string {
  try {
    return new URL('.', document.baseURI).pathname
  } catch {
    // No document: a test, or a runtime without one. The old behaviour is the right fallback.
    return '/'
  }
}

const API = apiBase()

const POST_RETRIES = 3
const RETRY_DELAY_MS = 700

/**
 * How many messages are held while the stream is down before the loss is reported.
 *
 * Large enough that no real page reaches it — the UI posts on user action, and a disconnected
 * page offers little to act on. It exists so the queue cannot grow without bound, and it reports
 * rather than discarding quietly, because silent loss is the bug this queue was written to fix.
 */
const MAX_QUEUED = 500

export class HttpTransport implements Transport {
  private readonly listeners = new Set<(message: unknown) => void>()
  private token: string | undefined

  /**
   * Whether a stream is open *right now*, and what to send once one is.
   *
   * ## The reported failure
   *
   * "There is no dark mode or light mode option any more", on a remote server, with the version
   * confirmed as the one that had already fixed this on the server side.
   *
   * `connect()` starts the event stream but does not wait for it — `void this.listen()` — so it
   * resolves, React mounts, and the five startup requests go out at once. The server answers a
   * message with `409 No event stream open` until the stream it belongs to exists, so on a fresh
   * server the first of those five is refused. Measured against the published build: the stream
   * opened 51ms later and the first POST still lost the race on loopback.
   *
   * The 409 retry covers that, but only for about two seconds. Over a proxy on a remote server
   * the stream can take longer, and then the startup requests are gone permanently — `settings`
   * among them, which is the message carrying `choosesTheme`. So the theme control is absent, the
   * Agents tab is empty and the model list never loads, all from one lost second.
   *
   * ## Why a queue rather than awaiting the stream in `connect()`
   *
   * Waiting would mean a server that is slow to answer renders nothing at all, trading a missing
   * control for a blank page. Holding the messages instead lets the page paint immediately and
   * costs the sender nothing, and it covers a mid-session drop as well as startup — where
   * awaiting would only ever have covered the first connection.
   *
   * This is the client half of the rule already written into the server: **a window that cannot
   * exist beats one something else recovers from.** The 409 retry stays as a fallback for a race
   * this does not anticipate.
   *
   * ## And why the wait is bounded by a fallback rather than by a warning
   *
   * Without a bound the queue turned a *reported* failure into a silent one. Reported again from
   * a Linux server behind a proxy: the theme control missing and Save closing having saved
   * nothing, with no error anywhere. Before the queue those requests were refused and the refusal
   * was surfaced; after it they sat in the list for ever, because the event stream never opened
   * at all — and a message waiting is indistinguishable from a message sent.
   *
   * The first answer was to warn after fifteen seconds. That reported the problem without fixing
   * it, so `startPolling` replaces it: the stream is given eight seconds, and after that replies
   * are fetched with ordinary short requests instead. Two mechanisms would have disagreed anyway
   * — a warning saying "nothing has been saved" is false the moment the fallback has saved it.
   */
  private streamOpen = false
  private queued: unknown[] = []
  /**
   * Set once the stream has been given up on and replies are being fetched instead.
   *
   * Reported from a Linux server behind a proxy: the stream never opened — not slowly, never.
   * `fetch` did not resolve its headers, so nothing was refused and nothing errored, while the
   * session on the server stayed perfectly healthy. Padding the stream defeats an intermediary
   * that buffers by *size*; it does nothing against one that holds a response until it is
   * complete, and an event stream never completes.
   *
   * An ordinary short request that finishes is the one shape every intermediary handles. It is
   * worse than a stream — a second of latency, and a reply arrives whole rather than as it is
   * written — and it is enormously better than a page that does nothing at all.
   */
  private polling = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private patienceTimer: ReturnType<typeof setTimeout> | undefined
  /** Consecutive failed polls, so a persistent failure reports once rather than every second. */
  private pollFailures = 0
  private pollReported = false
  /** When something was last sent or received, which decides how eagerly to poll. */
  private lastActivity = Date.now()

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
      const response = await fetch(`${API}api/session`, {
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

    /*
     * No fragment and nothing stored: ask anyway.
     *
     * A server started with `--no-token` hands one out to anybody, which is the point of the
     * flag; an ordinary one refuses, and the refusal reads exactly as it did before. One code
     * path rather than a second that only runs in one mode — the client cannot tell which kind of
     * server it is talking to, and should not have to.
     */
    if (this.token === undefined) {
      try {
        const open = await fetch(`${API}api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (open.ok) {
          this.token = ((await open.json()) as { token: string }).token
          sessionStorage.setItem('lightCodeToken', this.token)
        }
      } catch {
        // Falls through to the message below, which says what to do.
      }
    }

    if (this.token === undefined)
      throw new Error('No session. Restart light-code and open the printed URL.')
    this.awaitStream()
    void this.listen()
  }

  private async listen(): Promise<void> {
    for (;;) {
      try {
        /*
         * Which interface this tab is. Read from the address bar rather than stored, so the two
         * URLs behave as two URLs — opening /admin in a second tab does not retroactively change
         * what the first one is, and a reload of either lands where it was.
         */
        const view = window.location.pathname.startsWith('/admin') ? '?view=admin' : ''
        const response = await fetch(`${API}api/events${view}`, {
          headers: { Authorization: `Bearer ${this.token ?? ''}` },
        })
        if (!response.ok || response.body === null)
          throw new Error(`stream failed: ${response.status}`)
        this.onStatus('connected')
        // The server registers the session before it writes these headers, so by the time the
        // response is in hand a message posted now has somewhere to go.
        this.openStream()

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
        this.onStatus(
          `disconnected — retrying (${error instanceof Error ? error.message : String(error)})`,
        )
      }
      /*
       * Both ways out of the block above — the stream ending cleanly and it failing — mean there
       * is no longer anywhere for a message to be delivered, so anything posted from here waits.
       *
       * Unless polling has taken over, in which case there *is* somewhere: leaving `streamOpen`
       * true keeps posts going out, and returning stops the reconnect loop racing the poller.
       */
      if (this.polling) return
      this.streamOpen = false
      // The server going away during a restart is the common case, so reconnect rather
      // than leaving a dead page. Fixed delay: this is loopback, not a busy backend.
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  /**
   * Sends one message, and **says so when the server refuses it**.
   *
   * ## The reported failure
   *
   * "I clicked Save, it closed the window, and it didn't save anything." The old body was
   * `fetch(...).catch(...)`, and `catch` on a fetch fires only for a *network* error — a 401, a
   * 403 from the origin check, or the 409 this server returns when no event stream is open all
   * resolve perfectly happily and were dropped on the floor. The UI closed the dialog because it
   * had done its part, and nothing anywhere said the message had been thrown away.
   *
   * ## Why 409 is retried rather than reported
   *
   * It means the stream is not up *yet*, which during the second after a reconnect is ordinary
   * rather than wrong. The reconnect loop will have a stream again shortly, so this waits for it.
   * Every other status is a real refusal and is reported with its reason.
   */
  post(message: unknown): void {
    if (!this.streamOpen) {
      if (this.queued.length >= MAX_QUEUED) {
        this.onStatus(
          `still not connected, and ${String(MAX_QUEUED)} messages are already waiting — ` +
            'this one was dropped. Reload the page.',
        )
        return
      }
      this.queued.push(message)
      return
    }
    // Sending is activity: the reply to this is what the user is waiting for.
    this.lastActivity = Date.now()
    if (this.polling) this.schedulePoll()
    void this.send(message, 0)
  }

  /**
   * Gives the stream a bounded chance, then stops depending on it.
   *
   * Armed once per session rather than per attempt: a stream that opens and later drops is a
   * different thing, and the reconnect loop already handles that.
   */
  private awaitStream(): void {
    if (this.patienceTimer !== undefined || this.polling) return
    this.patienceTimer = setTimeout(() => {
      this.patienceTimer = undefined
      if (this.streamOpen || this.polling) return
      this.startPolling()
    }, STREAM_PATIENCE_MS)
  }

  private startPolling(): void {
    this.polling = true
    this.onStatus(
      'connected — the event stream did not open, so replies are being fetched instead. ' +
        'Something between this page and the server does not pass streaming responses through.',
    )
    /*
     * The first poll goes *before* the queue is flushed, and the order is load-bearing.
     *
     * A message posted to a server with no session for this principal is answered `409`, and the
     * session is created by whichever of `/api/events` or `/api/poll` arrives first. Flushing
     * first therefore spends the queue against a server that has not built one yet: every
     * startup request is refused, retried, and only then succeeds — the same lost second this
     * whole queue exists to prevent, one layer along.
     */
    void this.poll().finally(() => {
      /*
       * Flushing what was queued is the point: those are the startup requests, and without them
       * the settings reply never arrives and the page stays half-built — which is what the
       * missing light/dark control was.
       */
      this.openStream()
      this.schedulePoll()
    })
  }

  /**
   * Books the next poll at whichever rate the conversation deserves.
   *
   * A chain of timeouts rather than an interval, because the delay changes between one poll and
   * the next — and an interval whose period is fixed at creation cannot do that without being torn
   * down and rebuilt each time, which is the same thing written less clearly.
   */
  private schedulePoll(): void {
    if (!this.polling) return
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    const active = Date.now() - this.lastActivity < POLL_ACTIVE_WINDOW_MS
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll())
    }, active ? POLL_FAST_MS : POLL_IDLE_MS)
  }

  private async poll(): Promise<void> {
    try {
      const response = await fetch(`${API}api/poll`, {
        headers: { Authorization: `Bearer ${this.token ?? ''}` },
      })
      if (!response.ok) {
        this.notePollFailure()
        return
      }
      const body = (await response.json()) as { messages?: unknown[] }
      this.pollFailures = 0
      if (this.pollReported) {
        this.pollReported = false
        this.onStatus('connected.')
      }
      const messages = body.messages ?? []
      // Anything arriving means the conversation is live, so the next poll comes quickly.
      if (messages.length > 0) this.lastActivity = Date.now()
      for (const message of messages) {
        for (const listener of this.listeners) listener(message)
      }
    } catch {
      // One failure is the next poll's problem; a run of them is the user's.
      this.notePollFailure()
    }
  }

  /**
   * The last backstop.
   *
   * Once polling has taken over there is nothing further to fall back to, so a poll that keeps
   * failing is somebody watching a page that will never answer — and the only thing worse than
   * that is one that will never answer and never says so.
   */
  private notePollFailure(): void {
    this.pollFailures += 1
    if (this.pollFailures < POLL_FAILURES_BEFORE_REPORTING || this.pollReported) return
    this.pollReported = true
    this.onStatus(
      'cannot reach the server — the event stream did not open and fetching replies is failing ' +
        'too, so nothing is being saved. Check that the address in the browser reaches the ' +
        'server light-code printed.',
    )
  }

  /** Marks the stream up and releases everything posted while it was not, in order. */
  private openStream(): void {
    this.streamOpen = true
    if (this.patienceTimer !== undefined) {
      clearTimeout(this.patienceTimer)
      this.patienceTimer = undefined
    }
    // Taken before sending: `send` is async, so a failure that re-queues must not append to the
    // list being drained.
    const waiting = this.queued
    this.queued = []
    for (const message of waiting) void this.send(message, 0)
  }

  private async send(message: unknown, attempt: number): Promise<void> {
    try {
      const response = await fetch(`${API}api/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token ?? ''}`,
        },
        body: JSON.stringify(message),
      })
      if (response.ok) return

      if (response.status === 409 && attempt < POST_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        await this.send(message, attempt + 1)
        return
      }

      // The server's own sentence where there is one; it names what was refused and why.
      const reason = (await response.text().catch(() => '')).trim()
      this.onStatus(
        `the server refused that (${String(response.status)})${reason.length > 0 ? `: ${reason}` : ''}`,
      )
    } catch (error) {
      if (attempt < POST_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        await this.send(message, attempt + 1)
        return
      }
      this.onStatus(
        `could not reach the server: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
