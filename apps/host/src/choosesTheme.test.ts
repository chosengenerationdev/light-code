import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * Whether the browser is offered a light/dark choice.
 *
 * Reported more than once as "there is no theme selector in the node version", and it has had two
 * separate causes already — the settings reply being lost in a stream that kept dropping, and then
 * being sent only when asked for. Both were about *delivery*.
 *
 * This pins the other half: that the flag is `true` in what the server actually sends. It is
 * derived — `choosesTheme: ui.openWalkthrough === undefined`, on the reasoning that a host with
 * native onboarding is a host with a native theme — and a derived flag is exactly the kind that
 * goes wrong silently when the thing it is derived from changes for an unrelated reason. If this
 * host ever gains a walkthrough, the theme control disappears and nothing else would say why.
 *
 * Driven against a running server, because the claim is about the bytes on the wire.
 */

let running: RunningServer | undefined
let dataDir = ''

afterEach(async () => {
  await running?.close()
  running = undefined
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('the settings the browser is sent', () => {
  it('say the browser picks its own theme', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-theme-'))
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
    const url = running.url

    const settings: Record<string, unknown>[] = []
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && settings.length === 0) {
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      const body = (await response.json()) as { messages: Record<string, unknown>[] }
      settings.push(...body.messages.filter((message) => message['type'] === 'settings'))
      if (settings.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(settings.length).toBeGreaterThan(0)
    /*
     * The control is rendered on `choosesTheme === true` and nothing else, so this is the whole of
     * what the host has to get right. Everything else about the theme is delivery.
     */
    expect(settings[0]?.['choosesTheme']).toBe(true)
  }, 20_000)
})
