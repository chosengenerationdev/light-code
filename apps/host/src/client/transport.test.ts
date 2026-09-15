// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTransport } from './transport.js'

/**
 * The startup race, which is invisible to any test of the server.
 *
 * The server is correct: it registers the session before writing the stream's headers, and it
 * answers `409 No event stream open` to a message that has no stream. The fault was that the
 * client posted into the gap — `connect()` resolved without waiting for the stream, React
 * mounted, and five startup requests went out at once.
 *
 * So this test is about *ordering between two requests*, and it holds the event stream open-but-
 * unanswered to make the gap wide enough to observe. Against a real loopback server the gap is
 * about fifty milliseconds, which is enough to lose a message and far too little to test against.
 */
interface Recorded {
  type: string
  status: number
}

function harness(): {
  transport: HttpTransport
  posts: Recorded[]
  statuses: string[]
  polled: unknown[]
  pollCount: () => number
  openStream: () => void
} {
  const posts: Recorded[] = []
  const statuses: string[] = []
  // Replies the server is holding for a client that cannot receive a stream.
  const polled: unknown[] = []
  let polls = 0
  let streamOpen = false
  let release: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })

  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === '/api/session') return { ok: true, json: async () => ({ token: 't' }) }

    if (url === '/api/poll') {
      polls += 1
      const messages = polled.splice(0, polled.length)
      return { ok: true, json: async () => ({ messages }) }
    }

    if (url.startsWith('/api/events')) {
      await opened
      streamOpen = true
      return {
        ok: true,
        // A stream that never delivers and never ends: this test is about what the client sends.
        body: { getReader: () => ({ read: () => new Promise(() => undefined) }) },
      }
    }

    const { type } = JSON.parse(init?.body ?? '{}') as { type: string }
    /*
     * The server refuses on `409` when the *session* does not exist, not when a stream is
     * missing — and it creates the session in `/api/poll` exactly as it does in `/api/events`.
     * Modelling that matters: without it a polling client looks like it is being refused, which
     * is the opposite of the property under test.
     */
    const status = streamOpen || polls > 0 ? 202 : 409
    posts.push({ type, status })
    return { ok: streamOpen, status, text: async () => 'No event stream open. Reload the page.' }
  })

  return {
    transport: new HttpTransport((status) => statuses.push(status)),
    posts,
    statuses,
    polled,
    pollCount: () => polls,
    openStream: () => {
      release()
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('posting before the event stream is open', () => {
  it('holds the startup requests until there is somewhere to deliver them', async () => {
    const { transport, posts, statuses, openStream } = harness()

    await transport.connect()

    // Exactly what App.tsx posts on mount, in that order.
    const startup = [
      'requestProfiles',
      'requestSettings',
      'requestMcp',
      'requestExpert',
      'requestAgents',
    ]
    for (const type of startup) transport.post({ type })

    // Nothing has been sent, because nothing could have been answered.
    expect(posts).toEqual([])

    openStream()
    await vi.waitFor(() => {
      expect(posts).toHaveLength(startup.length)
    })

    // Every one arrived, in order, and none was refused. `requestSettings` is the one that
    // carries `choosesTheme` — losing it is what removed the light/dark control.
    expect(posts.map((post) => post.type)).toEqual(startup)
    expect(posts.every((post) => post.status === 202)).toBe(true)
    expect(statuses.filter((status) => status.includes('refused'))).toEqual([])
  })

  it('sends straight away once the stream is up, rather than queueing for ever', async () => {
    const { transport, posts, openStream } = harness()

    await transport.connect()
    openStream()

    transport.post({ type: 'requestSettings' })
    await vi.waitFor(() => {
      expect(posts).toEqual([{ type: 'requestSettings', status: 202 }])
    })
  })
})

/**
 * When the environment will not carry a stream at all.
 *
 * Reported from a Linux server behind a proxy: the stream never opened — not slowly, never.
 * `fetch` did not resolve its headers, so nothing was refused and nothing errored; every message
 * sat in the queue while the session on the server was perfectly healthy. Padding the stream
 * defeats an intermediary that buffers by *size*; it does nothing against one that holds a
 * response until it is complete, and an event stream never completes.
 *
 * So the client stops depending on it. An ordinary short request that finishes is the one shape
 * every intermediary handles.
 */
describe('falling back to polling', () => {
  it('sends what was queued once it gives up on the stream', async () => {
    vi.useFakeTimers()
    try {
      const { transport, posts, statuses } = harness()
      await transport.connect()

      transport.post({ type: 'requestSettings' })
      expect(posts).toEqual([])

      await vi.advanceTimersByTimeAsync(9_000)

      // The startup requests are what matter: without them the settings reply never arrives and
      // the page stays half-built, which is what "no dark mode option" was.
      await vi.waitFor(() => {
        expect(posts.map((post) => post.type)).toEqual(['requestSettings'])
      })
      expect(statuses.some((status) => status.includes('fetched instead'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers replies it fetches', async () => {
    vi.useFakeTimers()
    try {
      const { transport, polled } = harness()
      const seen: unknown[] = []
      transport.onMessage((message) => seen.push(message))
      await transport.connect()

      polled.push({ type: 'settings', choosesTheme: true })
      await vi.advanceTimersByTimeAsync(9_000)

      await vi.waitFor(() => {
        expect(seen).toEqual([{ type: 'settings', choosesTheme: true }])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  /* A stream that opens normally must never start polling — this is a fallback, not a mode. */
  it('does not poll when the stream opens', async () => {
    vi.useFakeTimers()
    try {
      const { transport, statuses, openStream, pollCount } = harness()
      await transport.connect()
      openStream()
      await vi.advanceTimersByTimeAsync(30_000)

      expect(pollCount()).toBe(0)
      expect(statuses.some((status) => status.includes('fetched instead'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
