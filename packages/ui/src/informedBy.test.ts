import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8')

/**
 * The specialist's name has to survive the trip to the screen.
 *
 * Reported as "it always says informed by expert", and as the colour never changing — one cause.
 * `App.tsx` rebuilds each display message **field by field**, and four of those constructions
 * copied `expertInformed` without `informedBy`, so the role was dropped between the host and the
 * chip that renders it.
 *
 * CLAUDE.md records this file doing exactly this before: it unpacked the expert message field by
 * field, and every field added to the protocol afterwards was silently discarded — "the host was
 * correct, the protocol was correct, and the UI was quietly discarding the answer". The fix then
 * was to assign the whole message; here the shape genuinely is a rebuild, so this counts instead.
 */
describe('the role reaches the chat', () => {
  /**
   * One `informedBy` for every `expertInformed`.
   *
   * Counted rather than spot-checked: what fails here is a *new* construction added later that
   * copies the flag and forgets the role, and no test of the renderer can see that.
   */
  it('is copied wherever the informed flag is', () => {
    const flags = app.match(/expertInformed: true/g) ?? []
    const roles = app.match(/informedBy: (message|last)\.informedBy/g) ?? []
    expect(flags.length).toBeGreaterThan(0)
    expect(
      roles.length,
      'a display message copies expertInformed without informedBy, so the chip will say "a specialist"',
    ).toBe(flags.length)
  })

  /**
   * And nothing fills a missing role in with "expert".
   *
   * That fallback is what hid the drop: a field that never arrived rendered as a confident claim
   * about who had answered, rather than as the absence it was.
   */
  it('does not substitute the expert for a role it does not have', () => {
    const list = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'MessageList.tsx'),
      'utf8',
    )
    expect(
      list.includes("informedBy ?? 'expert'"),
      'a missing role is being called the expert',
    ).toBe(false)
    expect(list).toContain('function describeInformer(')
  })
})
