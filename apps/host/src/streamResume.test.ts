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
   * The very first request a page makes must not be refused.
   *
   * A streamed `fetch` resolves for the client the moment headers arrive, and the page sends its
   * opening requests immediately. While the session was created *after* those headers, the first
   * POST landed in a window answered `409 No event stream open` — and the client dropped the
   * refusal silently, so the reply simply never came.
   *
   * That window is what "there is no dark mode option any more" was: `choosesTheme` rides on the
   * settings reply, the request for it was refused, and nothing said so. Measured against a
   * running server, not reasoned about — the probe that found it was posting without checking
   * its own status, which is the same mistake one layer up.
   */
  it('accepts a message sent the instant the stream opens', async () => {
    const url = await start()
    const stream = await openStream(url)

    // No wait: this is the race, and sleeping first would test the absence of one.
    const posted = await fetch(`${url}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ type: 'requestSettings' }),
    })
    expect(posted.status).toBe(202)

    expect(await until(() => stream.frames.join('').includes('"type":"settings"'))).toBe(true)
    stream.abort()
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

/**
 * An event stream has to survive a buffering proxy, and that is a claim about bytes on the wire.
 *
 * Reported from a Linux server reached through a proxy: the light/dark control missing and Save
 * closing having saved nothing, on the current build. A proxy with response buffering on forwards
 * when its buffer *fills* or the response *ends* — nginx's `proxy_buffer_size` defaults to 4 KB,
 * 8 KB on some builds — and an event stream never ends. The server wrote fourteen bytes to open
 * and eight every twenty seconds after that, so the first reply would clear a 4 KB buffer about
 * eight minutes later. From the page that is indistinguishable from a server that answers nothing.
 *
 * `X-Accel-Buffering: no` and `Cache-Control: no-transform` ask for the same thing politely and
 * are ignored by most proxies that are not nginx. The padding does not ask.
 *
 * Measured against the running server, because the whole claim is how much arrives and how soon.
 */
describe('opening an event stream through something that buffers', () => {
  it('sends enough immediately to clear a proxy buffer', async () => {
    const url = await start()
    const stream = await openStream(url)

    expect(await until(() => stream.frames.join('').length >= 4096)).toBe(true)
    /*
     * The *first frame*, not the total. Whatever the server happens to send next would otherwise
     * satisfy this on its own — and it does, which is exactly why a proxy sometimes releases the
     * page and then nothing else. What has to clear the buffer is the opening write itself.
     */
    const first = stream.frames.join('').split('\n\n')[0] ?? ''
    // Enough for the 8 KB variant too, since that is the one that would otherwise still hang.
    expect(first.length).toBeGreaterThanOrEqual(8192)
    stream.abort()
  })

  /*
   * A comment, so it is padding rather than content. The client only acts on frames beginning
   * `data: `; anything else is ignored, which is what makes this safe to send to every client
   * including the ones that never needed it.
   */
  it('sends it as a comment no client will read as an event', async () => {
    const url = await start()
    const stream = await openStream(url)

    expect(await until(() => stream.frames.join('').length >= 8192)).toBe(true)
    const opening = stream.frames.join('')
    // The *first* frame is the padding, and it is a comment. Real events follow it immediately —
    // that is the point: they are what the padding has just made deliverable.
    const frames = opening.split('\n\n')
    expect(frames[0]?.startsWith(': ')).toBe(true)
    expect(frames[0]?.startsWith('data: ')).toBe(false)
    stream.abort()
  })

  /*
   * Not one byte repeated. An intermediary that gzips would squeeze 8 KB of the same character
   * into almost nothing and the padding would buy nothing — and `no-transform` is exactly the
   * header such a proxy has already ignored.
   */
  it('pads with something that does not compress to nothing', async () => {
    const url = await start()
    const stream = await openStream(url)

    expect(await until(() => stream.frames.join('').length >= 8192)).toBe(true)
    const padding = stream.frames.join('').split('\n\n')[0]?.slice(2) ?? ''
    expect(padding.length).toBeGreaterThanOrEqual(8192)
    expect(new Set(padding).size).toBeGreaterThan(8)
    stream.abort()
  })

  /* And the headers that ask nicely are still there, for the proxies that do listen. */
  it('still asks not to be buffered', async () => {
    const url = await start()
    const stream = await openStream(url)

    expect(stream.response.headers.get('x-accel-buffering')).toBe('no')
    expect(stream.response.headers.get('cache-control')).toContain('no-transform')
    stream.abort()
  })
})
