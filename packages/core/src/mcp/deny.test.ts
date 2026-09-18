import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { denyCheck } from './deny.js'
import { mcpServersSchema } from './types.js'

/**
 * Calls a server may never make.
 *
 * Asked for in these terms: the assistant may fill a web form and click Next, but must not click
 * the final submit — the person reviews and submits it. Guidance alone cannot promise that, and a
 * heuristic that tried to *recognise* a submit button would be wrong often enough to be dangerous
 * while sounding certain.
 *
 * So it is declared. The user says what must not happen; nothing here guesses.
 */

const submitRule = [{ tools: ['click'], contains: 'submit', reason: 'You review and submit.' }]

describe('a rule the user declared', () => {
  it('refuses the call it names', () => {
    expect(denyCheck('click', { selector: '#submit-claim' }, submitRule).denied).toBe(true)
  })

  /* Next is the whole point of the example: the rule must not stop ordinary progress. */
  it('lets everything else through', () => {
    expect(denyCheck('click', { selector: '#next-step' }, submitRule).denied).toBe(false)
    expect(denyCheck('fill', { selector: '#submit-claim', value: 'x' }, submitRule).denied).toBe(false)
  })

  it('says why, in the words the user wrote', () => {
    expect(denyCheck('click', { selector: '#submit' }, submitRule).message).toContain(
      'You review and submit.',
    )
  })

  it('still says something useful when no reason was given', () => {
    const decision = denyCheck('click', { selector: '#submit' }, [{ contains: 'submit' }])
    expect(decision.message).toContain('Ask the user to do this step themselves')
  })
})

describe('what it matches against', () => {
  /*
   * The arguments serialised, not walked: a server's argument shape is its own business, and a
   * guard that had to know which field held the selector would break when the server changed.
   */
  it('finds the text wherever it sits in the arguments', () => {
    expect(denyCheck('click', { target: { label: 'Submit claim' } }, submitRule).denied).toBe(true)
    expect(denyCheck('click', { candidates: ['next', 'submit'] }, submitRule).denied).toBe(true)
  })

  it('ignores case, because a label is written however the page writes it', () => {
    expect(denyCheck('click', { label: 'SUBMIT' }, submitRule).denied).toBe(true)
  })

  it('applies to every tool when none is named', () => {
    const anyTool = [{ contains: 'danger' }]
    expect(denyCheck('anything', { x: 'danger' }, anyTool).denied).toBe(true)
  })

  it('does nothing when there are no rules', () => {
    expect(denyCheck('click', { selector: '#submit' }, undefined).denied).toBe(false)
    expect(denyCheck('click', { selector: '#submit' }, []).denied).toBe(false)
  })

  /* A guard that cannot read what it is checking must not wave it through. */
  it('refuses arguments it cannot serialise', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(denyCheck('click', circular, submitRule).denied).toBe(true)
  })

  it('ignores an empty rule rather than refusing everything', () => {
    expect(denyCheck('click', { selector: '#next' }, [{ contains: '   ' }]).denied).toBe(false)
  })
})

describe('configuring it', () => {
  it('is accepted on a server pasted from a config file', () => {
    const parsed = mcpServersSchema.safeParse({
      chrome: {
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp'],
        deny: [{ tools: ['click'], contains: 'submit', reason: 'You review and submit.' }],
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('is accepted on an HTTP server too', () => {
    const parsed = mcpServersSchema.safeParse({
      remote: { url: 'https://mcp.example/mcp', deny: [{ contains: 'delete' }] },
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a rule with nothing to match on', () => {
    expect(mcpServersSchema.safeParse({ a: { url: 'https://x.example/', deny: [{ contains: '' }] } }).success).toBe(
      false,
    )
  })
})

/**
 * Where it is enforced, asserted against the source.
 *
 * The check belongs at the one place a call leaves for the server — not in the loop and not in the
 * approval gate, because both of those can be auto-approved, and a rule written to mean "never"
 * must not be satisfiable by ticking a box. That is a property of *which* function calls it, which
 * no test of `denyCheck` itself can see.
 */
describe('where the check happens', () => {
  it('runs where the call is dispatched, not where it is approved', async () => {
    const source = await fs.readFile(path.join(import.meta.dirname, 'registry.ts'), 'utf8')
    const adapter = source.slice(source.indexOf('tool: adaptTool('))
    expect(adapter.slice(0, adapter.indexOf('\n        })'))).toContain('denyCheck(')
  })

  it('reads the rules at call time, so an edit applies to the next call', async () => {
    const source = await fs.readFile(path.join(import.meta.dirname, 'registry.ts'), 'utf8')
    // `this.servers[name]` rather than a value captured when the tool was adapted.
    expect(source).toContain('denyCheck(descriptor.name, args, this.servers[name]?.deny)')
  })
})
