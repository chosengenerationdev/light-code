import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildPlanGuidance } from './plan.js'

/**
 * A plan the user sets for one chat, and the words that make it stick.
 *
 * Requested after watching an agent wander: doing the thing asked, then carrying on into an
 * adjacent refactor nobody scoped. The guidance *is* the feature here, exactly as Junior mode's
 * was, so it is worth pinning what it actually says.
 */
describe('the plan in the prompt', () => {
  const guidance = buildPlanGuidance('1. Fix retry logic\n2. Add a timeout test')

  it('carries the plan verbatim', () => {
    expect(guidance).toContain('1. Fix retry logic')
    expect(guidance).toContain('2. Add a timeout test')
  })

  /** A chat without a plan should cost nothing and read exactly as it did before. */
  it('says nothing at all when there is no plan', () => {
    expect(buildPlanGuidance(undefined)).toBe('')
    expect(buildPlanGuidance('   ')).toBe('')
  })

  /**
   * The drift this exists to stop, named explicitly.
   *
   * "Stay focused" is not actionable; "if you spot an unrelated bug, say so and carry on" is. An
   * agent that notices something worth fixing and fixes it is being helpful in the way that makes
   * a two-step task into a twenty-step one.
   */
  it('tells it to report a tempting detour rather than take it', () => {
    expect(guidance).toMatch(/noticing something else is useful/i)
    expect(guidance).toMatch(/do not fix it because you are there/i)
  })

  it('tells it to check each step against the plan before taking it', () => {
    expect(guidance).toMatch(/before each step, check it serves the plan/i)
  })

  /**
   * A plan the user set and a plan the model preferred are different things.
   *
   * Silently substituting a better one is the failure that looks like success: the work is good,
   * and it is not the work that was agreed.
   */
  it('tells it to say so rather than quietly substitute its own plan', () => {
    expect(guidance).toMatch(/if the plan turns out to be wrong/i)
    expect(guidance).toMatch(/only\s+one of them was agreed/i)
  })

  /** The end is where drift becomes visible, so completion has to reconcile against it. */
  it('requires the final summary to account for the plan', () => {
    expect(guidance).toContain('attempt_completion')
    expect(guidance).toMatch(/what is done, what is not/i)
  })
})

/**
 * The prompt prefix may change when the *user* changes something, and not otherwise.
 *
 * §12 is strict that tool definitions must stay byte-stable within a session, because they sit at
 * the front of the prompt. The plan lives in the system prompt, which has the same carve-out mode
 * switching already uses — but a tool description that varied with the plan would break the rule
 * outright, so the first design of this was wrong and is recorded as such.
 */
describe('the prompt cache', () => {
  it('keeps the plan out of any tool description', () => {
    const tools = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools')
    const completion = readFileSync(path.join(tools, 'attemptCompletion.ts'), 'utf8')
    expect(
      completion.toLowerCase().includes('plan'),
      'attempt_completion mentions the plan, which makes the tool block vary with it',
    ).toBe(false)
  })

  it('is only reached through the system prompt', () => {
    const prompt = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'systemPrompt.ts'),
      'utf8',
    )
    expect(prompt).toContain('buildPlanGuidance(options.plan)')
  })
})
