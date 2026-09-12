import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const loop = readFileSync(fileURLToPath(new URL('./loop.ts', import.meta.url)), 'utf8')

/**
 * Reporting progress must not spend the budget meant for work.
 *
 * A planned task calls `plan_progress` twice per checkpoint, so a six-step plan was spending
 * twelve of twenty-five steps saying what it was about to do — the plan feature taxing the work it
 * exists to organise, surfacing as "stopped after 25 steps" in the middle of something healthy.
 *
 * Read from the source rather than driven through the loop: the property is about *which* calls
 * count, and a behavioural test would need a provider, a registry and twenty-five round trips to
 * observe one arithmetic decision.
 */
describe('the step budget', () => {
  it('refunds a bookkeeping call', () => {
    expect(loop).toContain('BOOKKEEPING_TOOLS.has(toolCall.name)')
    expect(loop).toContain('iteration -= 1')
  })

  /*
   * The bound is the part worth pinning. Without it a model calling nothing but `plan_progress`
   * is never stopped, and a cap that cannot be reached is not a cap — which is precisely the
   * thing this was asked to relax, not to remove.
   */
  it('bounds the refunds, so the cap can still be reached', () => {
    expect(loop).toContain('refunded < MAX_REFUNDED_STEPS')
    expect(loop).toMatch(/const MAX_REFUNDED_STEPS = \d+/)
  })

  /*
   * Only calls that change nothing the agent can react to. A `read_file` is work — it is how a
   * model loops on something it cannot get right, which is the failure the cap catches — so
   * widening this to "read-only tools" would quietly remove the cap for the commonest loop.
   */
  it('refunds only what reports, never what acts', () => {
    const set = /const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(loop)
    expect(set).not.toBeNull()
    const names = (set?.[1] ?? '').match(/'[^']+'/g) ?? []
    expect(names).toEqual(["'plan_progress'"])
  })

  it('refunds after the result is recorded, so the transcript still shows it', () => {
    const refundAt = loop.indexOf('BOOKKEEPING_TOOLS.has(toolCall.name)')
    const recordAt = loop.indexOf('conversation.addToolResultMessage(toolCall.id, forModel)')
    expect(recordAt).toBeGreaterThan(-1)
    expect(refundAt).toBeGreaterThan(recordAt)
  })
})
