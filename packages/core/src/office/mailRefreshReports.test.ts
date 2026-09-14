import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bridge = readFileSync(
  fileURLToPath(new URL('../host/bridge.ts', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n')

const handler = bridge.slice(
  bridge.indexOf('async function handleRefreshMail'),
  bridge.indexOf('/** Applies retention, quietly, as part of an ordinary sync. */'),
)

/**
 * A button the user just pressed must say something.
 *
 * Reported from real use: "nothing shown when I clicked refresh, no progress bar". Two of the
 * three guards returned in silence — `mailBusy`, which fires exactly when the automatic timer
 * happens to be mid-sync and is invisible from the tab, and the Outlook availability check.
 *
 * A control that answers nothing is indistinguishable from a broken one. Worse here: the user was
 * chasing missing emails, and the silent button took away the one clue that would have told them
 * why nothing was happening.
 *
 * Read from the source because what is asserted is that no path out is silent, which no test of
 * the working path can see.
 */
describe('every way out of a mail refresh reports', () => {
  it('found the handler', () => {
    expect(handler.length).toBeGreaterThan(200)
  })

  it('says so when a sync is already running', () => {
    expect(handler).toContain('A mail sync is already running')
  })

  it('distinguishes Outlook switched off from Outlook unreachable', () => {
    expect(handler).toContain('Outlook is switched off')
    expect(handler).toContain('Outlook is not available on this host')
  })

  it('still reports an empty folder list', () => {
    expect(handler).toContain('No folders selected.')
  })

  /*
   * The specific regression: a bare `return` with nothing posted. Every early exit must set
   * `mailLastResult` and push it, which is what puts a line on the screen.
   */
  /*
   * Stated as a count rather than a pattern: every way out of the guard block sets a message
   * *and* sends it. A bare `return` after posting is fine — what must never happen is an exit
   * that leaves nothing on the screen, which is what was reported.
   */
  it('leaves no silent early return', () => {
    const guards = handler.slice(0, handler.indexOf('mailBusy = true'))
    const exits = [...guards.matchAll(/\breturn\b/g)].length
    const messages = [...guards.matchAll(/mailLastResult =/g)].length
    const posts = [...guards.matchAll(/postMailStatus\(\)/g)].length
    expect(exits).toBeGreaterThan(0)
    expect(messages).toBe(exits)
    expect(posts).toBe(exits)
  })
})
