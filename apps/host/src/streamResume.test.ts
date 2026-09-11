import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer, type RunningServer } from './server.js'

/**
 * A dropped event stream must not cost the session — measured against a running server.
 *
 * Reported from a Linux server: "UI says disconnected every few mins, I had to restart
 * light-code". The client reconnects a second after any drop, and every reconnect was building a
 * whole new session — bridge, MCP connections, Python worker, schedule timer — after tearing the
 * old one down. On a link that blips, that is a restart loop the user cannot see.
 *
 * Driven through the real server rather than asserted about the source, because what is being
 * claimed is behaviour over two connections and a gap. The `logSink` is the instrument: a session
 * announces itself when it is built, so counting those lines counts sessions.
 */
let running: RunningServer | undefined
let dataDir: string
const lines: string[] = []

afterEach(async () => {
  await running?.close()
  running = undefined
  lines.length = 0
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
})

async function start(): Promise<string> {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-resume-'))
  running = await startServer({
    workspaceRoot: undefined,
    dataDir,
    clientDir: path.join(dataDir, 'client'),
    ripgrepPath: undefined,
    noToken: true,
    logSink: (line) => lines.push(line),
  })
  return running.url
}

/** Opens a stream and returns it plus a way to read frames, without waiting for it to end. */
async function openStream(
  url: string,
): Promise<{ response: Response; abort: () => void; frames: string[] }> {
  const controller = new AbortController()
  const response = await fetch(`${url}/api/events`, {
    headers: { Origin: url },
    signal: controller.signal,
  })
  const frames: string[] = []
  void (async () => {
    const reader = response.body?.getReader()
    if (reader === undefined) return
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        frames.push(decoder.decode(value, { stream: true }))
      }
    } catch {
      // Aborting the read is how this test closes a stream; there is nothing to report.
    }
  })()
  return { response, abort: () => controller.abort(), frames }
}

/** Polls rather than sleeping on a guess — the assertion is about arrival, not about timing. */
async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

function sessionsBuilt(): number {
  return lines.filter((line) => line.includes('session for')).length
}

describe('an event stream that drops and comes back', () => {
  it('resumes the session it had rather than building another', async () => {
    const url = await start()

    const first = await openStream(url)
    expect(await until(() => sessionsBuilt() === 1)).toBe(true)

    first.abort()
    // The server learns the peer has gone from the socket closing, not from the abort itself.
    await until(() => false, 200)

    const second = await openStream(url)
    expect(await until(() => second.frames.length > 0)).toBe(true)

    // The whole point: one session across two streams.
    expect(sessionsBuilt()).toBe(1)
    second.abort()
  }, 30_000)

  /**
   * A message sent while nothing is listening used to be answered into a void.
   *
   * Every host→UI reply travels the stream, so a reply produced during the second between a drop
   * and a reconnect was simply lost — and a control waiting for it waits for ever. That is what
   * "refresh the model list and it just says Loading" looks like from the outside.
   */
  it('delivers a reply produced while no stream was attached', async () => {
    const url = await start()

    const first = await openStream(url)
    expect(await until(() => sessionsBuilt() === 1)).toBe(true)
    first.abort()
    await until(() => false, 200)

    // Accepted, not refused: the session is still there to receive it.
    const posted = await fetch(`${url}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ type: 'requestProfiles' }),
    })
    expect(posted.status).toBe(202)

    const second = await openStream(url)
    expect(await until(() => second.frames.join('').includes('"type":"profiles"'))).toBe(true)
    second.abort()
  }, 30_000)

  /**
   * A proxy that buffers a response holds every event until it has "enough", which for a stream is
   * for ever: the page connects, renders, and then every reply appears to vanish. Neither header
   * is needed on loopback, which is exactly why their absence survived until this ran on a server.
   */
  it('tells an intermediary not to buffer it', async () => {
    const url = await start()
    const stream = await openStream(url)

    expect(stream.response.headers.get('x-accel-buffering')).toBe('no')
    expect(stream.response.headers.get('cache-control')).toContain('no-transform')
    stream.abort()
  }, 30_000)
})
