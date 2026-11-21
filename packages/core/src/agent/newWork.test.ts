import { describe, expect, it } from 'vitest'

import { parseCheckpoints, startsNewWork } from './checkpoints.js'

/**
 * A new topic in a chat that follows a strategy starts its loops afresh - otherwise the second topic finds the first
 * one's back-and-forth rounds used up and is refused. A revision of the current plan must not, or editing a plan
 * would hand out fresh rounds.
 */
const first = '1. Reviewer reads the module\n2. Programmer renames it\n3. Tester runs the suite'
const done = Object.fromEntries(parseCheckpoints(first).map((step) => [step.id, { status: 'done' as const, roles: [], at: 0 }]))

describe('startsNewWork', () => {
  it('is a new piece of work when there was no plan', () => {
    expect(startsNewWork(undefined, {}, first)).toBe(true)
  })

  it('is a new piece of work once every step of the last plan is done', () => {
    expect(startsNewWork(first, done, '1. Reviewer reads the export\n2. Programmer adds CSV')).toBe(true)
  })

  it('is a new piece of work when the new plan keeps none of the old steps', () => {
    expect(startsNewWork(first, {}, '1. Programmer adds CSV export\n2. Tester checks it')).toBe(true)
  })

  it('is a revision when the new plan keeps a step of an unfinished one', () => {
    expect(startsNewWork(first, {}, '1. Reviewer reads the module\n2. Programmer renames it carefully')).toBe(false)
  })

  it('is nothing when the plan is cleared', () => {
    expect(startsNewWork(first, done, undefined)).toBe(false)
  })
})
