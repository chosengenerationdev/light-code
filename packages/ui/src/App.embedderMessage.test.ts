import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8')

/**
 * The host→UI messages must reach the panel whole.
 *
 * This is the defect CLAUDE.md calls "the bug shape that keeps costing the most time", and it has
 * now happened three times: the expert message, and then the embedder message, which copied six
 * fields by hand while the host sent eight. `indexAlias` and `skillsAlias` were dropped, so saving
 * a team alias wrote it to disk and the panel never learned — the button stayed on "Save this
 * name" and the Publish step stayed disabled. From the outside, pressing Save did nothing.
 *
 * No test of the host or of the protocol can see that: both were correct. So this reads the file
 * and fails on the *shape*, the way `config/retrieval.test.ts` reads `bridge.ts`.
 */
describe('the embedder message reaches the panel whole', () => {
  const handler = source.slice(source.indexOf("message.type === 'embedder'"))
  const body = handler.slice(0, handler.indexOf('} else if'))

  it('assigns the message rather than copying named fields out of it', () => {
    expect(body).toContain('...embedderState')
  })

  it('does not read fields off the message one at a time', () => {
    const copied = [...body.matchAll(/message\.(\w+)/g)].map((match) => match[1]).filter((name) => name !== 'type')
    expect(copied).toEqual([])
  })
})
