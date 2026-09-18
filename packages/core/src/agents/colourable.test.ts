import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { isAgentRole, isColourableAgent } from './roles.js'

/**
 * Two different questions that were being answered by one function.
 *
 * Reported immediately after shipping the Claude colour: choosing one gave "There is no claude
 * role". The picker was there and the save refused it — a control that exists and cannot work,
 * which is worse than one that is missing.
 *
 * The cause is worth keeping: **colourable and assignable are not the same question.** A colour
 * marks *authorship* and belongs to anything that can author a reply. A role is a *seat* a model
 * can be put in. Claude is the first thing that is one without being the other, and the guard on
 * the colour handler was asking about seats.
 */

describe('what can be given a colour', () => {
  it('includes Claude, which is what the report was about', () => {
    expect(isColourableAgent('claude')).toBe(true)
  })

  it('includes every ordinary role', () => {
    for (const role of ['expert', 'programmer', 'reviewer', 'tester', 'librarian']) {
      expect(isColourableAgent(role)).toBe(true)
    }
  })

  it('includes a custom role somebody defined', () => {
    expect(isColourableAgent('designer', [{ id: 'designer', name: 'Designer' } as never])).toBe(true)
  })

  it('still refuses something that is neither', () => {
    expect(isColourableAgent('nonsense')).toBe(false)
  })
})

/**
 * The half that must not have moved. A "claude" role would be assignable — somebody could put a
 * model in it — and it would mean nothing, because nothing consults it.
 */
describe('what a model can be assigned to', () => {
  it('does not include Claude', () => {
    expect(isAgentRole('claude')).toBe(false)
  })

  it('still includes the real roles', () => {
    expect(isAgentRole('reviewer')).toBe(true)
  })
})

/**
 * Asserted against the source, because the defect was a call site asking the wrong question — and
 * no test of either function can see which one a handler chose to call.
 */
describe('which guard each handler uses', () => {
  const bridge = async (): Promise<string> =>
    fs.readFile(path.join(import.meta.dirname, '..', 'host', 'bridge.ts'), 'utf8')

  it('uses the colour question when setting a colour', async () => {
    const source = await bridge()
    const handler = source.slice(source.indexOf("message.type === 'setAgentColor'"))
    expect(handler.slice(0, handler.indexOf('else if'))).toContain('isColourableAgent(')
  })

  /* Exactly one handler was meant to change; the rest guard assignment and must not follow. */
  it('leaves the assignment guards alone', async () => {
    const source = await bridge()
    // One call site, not two: the import carries no parenthesis, which the first version of this
    // assertion counted as one and got the number wrong rather than the code.
    expect(source.split('isColourableAgent(').length - 1).toBe(1)
    // And the assignment guards are still there, asking the question they should.
    expect(source.split('isAgentRole(').length - 1).toBeGreaterThan(1)
  })
})
