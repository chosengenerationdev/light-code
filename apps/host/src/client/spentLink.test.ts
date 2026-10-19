// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTransport } from './transport.js'

/**
 * Reported from Fire Code: after a restart some chat tabs stayed on "That link has already been used.
 * A fresh one has been printed in the terminal." A chat page loaded a second time with its first,
 * single-use link was refused, while the session that link had opened sat in this tab's storage.
 */
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

function serverRefusingTheLink(): string[] {
  const sentTokens: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
    if (url === '/api/session') return { ok: false, text: async () => 'That link has already been used. A fresh one has been printed in the terminal.' }
    if (url.startsWith('/api/events')) {
      sentTokens.push(init?.headers?.['Authorization'] ?? '')
      return { ok: true, body: { getReader: () => ({ read: () => new Promise(() => undefined) }) } }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
  })
  return sentTokens
}

describe('a used launch link', () => {
  it('carries on with the session this tab already has', async () => {
    sessionStorage.setItem('lightCodeToken', 'session-from-first-load')
    window.history.replaceState(null, '', '/#t=spent')
    const sent = serverRefusingTheLink()
    await new HttpTransport(() => undefined).connect()
    await vi.waitFor(() => expect(sent).toEqual(['Bearer session-from-first-load']))
    // The link is still taken out of the address bar.
    expect(window.location.hash).toBe('')
  })

  it('still says why when this tab has no session', async () => {
    window.history.replaceState(null, '', '/#t=spent')
    serverRefusingTheLink()
    await expect(new HttpTransport(() => undefined).connect()).rejects.toThrow('already been used')
  })
})
