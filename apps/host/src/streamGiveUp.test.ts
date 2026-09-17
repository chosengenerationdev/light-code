import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { nextShortStreams, shouldStopStreaming } from './client/transport.js'

/**
 * Giving up on a stream that opens and then dies, over and over.
 *
 * Reported from a JupyterHub deployment: the page connected, dropped, reconnected and dropped
 * again, for ever — `stream failed: 599`, which is tornado's status for a proxied request its own
 * client abandoned. Every reply produced in the gaps was lost, so the settings reply never landed
 * and the page stayed half-built: no light/dark control, Save doing nothing, Test Connection
 * saying "Testing…" for good.
 *
 * The existing patience timer could not catch it. It is armed once and the stream *did* open —
 * the comment said a stream that opens and later drops is a different thing the reconnect loop
 * handles. It is not a different thing.
 */
describe('a stream that keeps dying young', () => {
  it('counts a short life towards giving up', () => {
    expect(nextShortStreams(1_000, 0)).toBe(1)
    expect(nextShortStreams(1_000, 1)).toBe(2)
  })

  /* Consecutive, so an ordinary overnight drop never accumulates. */
  it('forgets the count after a stream that actually worked', () => {
    expect(nextShortStreams(10 * 60 * 1000, 5)).toBe(0)
  })

  it('keeps streaming while it is only the occasional drop', () => {
    expect(shouldStopStreaming(nextShortStreams(60_000, 1))).toBe(false)
  })

  it('stops depending on the stream once it has failed repeatedly', () => {
    expect(shouldStopStreaming(2)).toBe(true)
  })
})

/**
 * The decision has to *reach* the reconnect loop.
 *
 * Asserted against the source because the defect is a call that is not made, which no test of the
 * function being called can see — the `config/retrieval.test.ts` pattern, for the same reason.
 */
describe('the reconnect loop', () => {
  const source = async (): Promise<string> =>
    fs.readFile(path.join(import.meta.dirname, 'client', 'transport.ts'), 'utf8')

  it('consults the give-up rule and falls back to polling', async () => {
    const listen = (await source()).split('private async listen(')[1] ?? ''
    const body = listen.slice(0, listen.indexOf('\n  private '))
    expect(body).toContain('nextShortStreams(')
    expect(body).toContain('shouldStopStreaming(')
    expect(body).toContain('this.startPolling()')
  })

  /*
   * The whole output is meant to be pasteable into a bug report, so it must never carry the
   * bearer token or a message body — a settings save holds an API key.
   *
   * `typeOf(message)` is the one permitted mention: it returns the discriminant and nothing else.
   * Removing it first is what makes the rest of the check mean "the whole object was passed".
   */
  it('never traces the token or a message body', async () => {
    const text = await source()
    for (const line of text.split('\n').filter((l) => l.includes('trace('))) {
      expect(line).not.toContain('this.token')
      expect(line.replaceAll('typeOf(message)', '')).not.toContain('message')
    }
  })
})
