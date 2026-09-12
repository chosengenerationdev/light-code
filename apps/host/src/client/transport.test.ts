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
