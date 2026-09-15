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
  openStream: () => void
} {
  const posts: Recorded[] = []
  const statuses: string[] = []
  let streamOpen = false
  let release: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })

  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === '/api/session') return { ok: true, json: async () => ({ token: 't' }) }

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
    const status = streamOpen ? 202 : 409
    posts.push({ type, status })
    return { ok: streamOpen, status, text: async () => 'No event stream open. Reload the page.' }
  })

  return {
    transport: new HttpTransport((status) => statuses.push(status)),
    posts,
    statuses,
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
 * A stream that never opens at all.
 *
 * Reported from a Linux server behind a proxy: the light/dark control missing, and Save closing
 * its dialog having saved nothing — with no error anywhere. The queue above is what made it
 * silent. Before it, those requests were refused and the refusal was surfaced; after it they sat
 * in the list for ever, and a message waiting is indistinguishable from a message sent.
 *
 * A proxy that buffers a response holds an event stream open and empty for ever. The server asks
 * it not to with `X-Accel-Buffering: no`, and not every proxy listens — so the wait is bounded and
 * says so. Same rule as Test Connection: something that cannot fail cannot report.
 */
describe('when the event stream never opens', () => {
  it('says so rather than waiting silently', async () => {
    vi.useFakeTimers()
    try {
      const { transport, posts, statuses } = harness()
      await transport.connect()

      transport.post({ type: 'saveProfile' })
      expect(posts).toEqual([])
      // Nothing said yet: a slow connection must not be reported as a broken one.
      expect(statuses.filter((status) => status.includes('not opened'))).toEqual([])

      await vi.advanceTimersByTimeAsync(20_000)

      const reported = statuses.filter((status) => status.includes('not opened'))
      expect(reported).toHaveLength(1)
      // The count, so the reader knows how much is outstanding rather than only that something is.
      expect(reported[0]).toContain('1 message(s)')
      expect(reported[0]).toContain('nothing has been saved')
      /*
       * The cause is offered, not asserted. A confident wrong diagnosis costs a search as well as
       * the failure — this project paid for that once with an Outlook timeout that sent somebody
       * hunting a dialog that did not exist.
       */
      expect(reported[0]).toContain('proxy')
      expect(reported[0]).not.toContain('is a proxy')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports once, not on every message', async () => {
    vi.useFakeTimers()
    try {
      const { transport, statuses } = harness()
      await transport.connect()

      for (let index = 0; index < 5; index += 1) transport.post({ type: 'saveProfile' })
      await vi.advanceTimersByTimeAsync(20_000)
      transport.post({ type: 'saveProfile' })
      await vi.advanceTimersByTimeAsync(20_000)

      expect(statuses.filter((status) => status.includes('not opened'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  /* Somebody told nothing was saved needs to know when that stops being true. */
  it('says so when it recovers, and sends what was waiting', async () => {
    vi.useFakeTimers()
    try {
      const { transport, posts, statuses, openStream } = harness()
      await transport.connect()

      transport.post({ type: 'saveProfile' })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(statuses.some((status) => status.includes('not opened'))).toBe(true)

      openStream()
      await vi.waitFor(() => {
        expect(posts).toHaveLength(1)
      })
      expect(statuses.some((status) => status.startsWith('connected'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
