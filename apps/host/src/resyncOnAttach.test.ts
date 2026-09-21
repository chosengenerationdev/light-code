import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * State a freshly attached view is given without asking.
 *
 * Reported from JupyterHub: chat working, but the Appearance tab had no light/dark control and
 * the panel looked like an older build. It was not an older build. The browser asks for its
 * startup state **once**, and the requests sent while the stream was dropping and reconnecting
 * were lost — `requestSettings` among them, which is the reply `choosesTheme` rides on. Nothing
 * ever asked again, so the panel stayed half-built until a reload.
 *
 * The extension has never had this, because it resyncs whenever a webview attaches. The browser
 * needs it more, not less: a webview attaches once, and this reattaches after every drop.
 *
 * Driven against a running server, because the claim is about what arrives unprompted.
 */

let running: RunningServer | undefined
let dataDir = ''

afterEach(async () => {
  await running?.close()
  running = undefined
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
})

async function start(): Promise<string> {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-resync-'))
  running = await startServer({
    workspaceRoot: undefined,
    dataDir,
    // The browser bundle is inlined at build time; these tests never fetch a page, so an
    // empty map is the honest stand-in for it.
    clientAssets: {},
    ripgrepPath: () => undefined,
    noToken: true,
    logSink: () => undefined,
  })
  return running.url
}

const drain = async (url: string): Promise<string[]> => {
  const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
  const body = (await response.json()) as { messages: { type: string }[] }
  return body.messages.map((message) => message.type)
}

describe('a view that attaches without asking for anything', () => {
  it('is sent its settings anyway', async () => {
    const url = await start()

    // The first poll creates the session. Nothing has posted `requestSettings` — that is the
    // point: a client whose startup request was lost must still end up with a built panel.
    await drain(url)

    const seen: string[] = []
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !seen.includes('settings')) {
      seen.push(...(await drain(url)))
      if (seen.includes('settings')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(seen).toContain('settings')
  }, 20_000)

  /*
   * Reported separately as "about five minutes for the saved providers to appear", and it is the
   * same fault: the chat header cannot render a provider selector it was never sent.
   */
  it('is sent the provider list too', async () => {
    const url = await start()
    await drain(url)

    const seen: string[] = []
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !seen.includes('profiles')) {
      seen.push(...(await drain(url)))
      if (seen.includes('profiles')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(seen).toContain('profiles')
  }, 20_000)

  /*
   * Once per attach, not once per poll. A polling client asks several times a second, and a
   * resync per poll would rebuild the whole panel continuously — which is worse than the bug.
   */
  it('does not resend it on every poll', async () => {
    const url = await start()

    const seen: string[] = []
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      seen.push(...(await drain(url)))
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(seen.filter((type) => type === 'settings').length).toBe(1)
  }, 20_000)
})
