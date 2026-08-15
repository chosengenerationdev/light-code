import { describe, expect, it } from 'vitest'

import { diffLines } from './diff.js'
/**
 * A new file is created from nothing, so every line of it is an addition.
 *
 * `''.split('\n')` returns `['']` — one empty line, not zero — and that phantom line was
 * matched against the first genuinely blank line in the new content and reported as context.
 * The approval prompt then showed a row of a brand-new file as "unchanged", numbered against a
 * file that does not exist. Invariant 8: this view is what the user reads to decide whether an
 * edit is safe, so it must not claim a line was already there.
 */
describe('a new file', () => {
  it('is entirely additions, even when it contains blank lines', () => {
    const after = '#!/usr/bin/env python3\n"""Doc.\n\nUsage: x\n"""\nimport sys\n'
    const lines = diffLines('', after)

    expect(lines.every((line) => line.kind === 'added')).toBe(true)
    expect(lines.some((line) => line.beforeLine !== undefined)).toBe(false)
  })

  it('numbers every line consecutively from one', () => {
    const lines = diffLines('', 'a\n\nb\n\nc')
    expect(lines.map((line) => line.afterLine)).toEqual([1, 2, 3, 4, 5])
  })

  it('reports a file being emptied as entirely removals', () => {
    const lines = diffLines('a\n\nb', '')
    expect(lines.every((line) => line.kind === 'removed')).toBe(true)
    expect(lines.map((line) => line.beforeLine)).toEqual([1, 2, 3])
  })

  it('has nothing to show when both sides are empty', () => {
    expect(diffLines('', '')).toEqual([])
  })
})
