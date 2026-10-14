import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * A run on the user's own machine has no Review or Variables tab.
 *
 * Both exist for a shared server (an admin approving what normal users wrote; variables an admin sets
 * for everybody), and on a local run - Fire Code always - they were two tabs nobody used. The panel
 * shows each only once the host answers its request, so the host not answering is what removes it.
 * Driven against a running server, because the claim is about what goes over the wire.
 */

let running: RunningServer | undefined
let dataDir = ''

afterEach(async () => {
  await running?.close()
  running = undefined
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('a local run', () => {
  it('does not answer for the server-only tabs, and still answers the rest', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-tabs-'))
    running = await startServer({
      workspaceRoot: undefined,
      dataDir,
      clientAssets: {},
      ripgrepPath: () => undefined,
      noToken: true,
      logSink: () => undefined,
    })
    const url = running.url
    await fetch(`${url}/api/poll`, { headers: { Origin: url } })
    for (const type of ['requestReviews', 'requestVariables', 'requestSettings']) {
      const posted = await fetch(`${url}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify({ type }),
      })
      expect(posted.status).toBe(202)
    }

    const received: string[] = []
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !received.includes('settings')) {
      const response = await fetch(`${url}/api/poll`, { headers: { Origin: url } })
      const body = (await response.json()) as { messages: { type: string }[] }
      received.push(...body.messages.map((message) => message.type))
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // The settings reply arriving proves the earlier two were processed, in order, before it.
    expect(received).toContain('settings')
    expect(received).not.toContain('reviews')
    expect(received).not.toContain('variables')
  }, 30_000)
})
