import { describe, expect, it } from 'vitest'

import { DEFAULT_MENTION_EXCLUDES, mentionExcludeGlob, mentionExcludes } from './mentionExcludes.js'

describe('which folders the @ picker skips', () => {
  /** The case that prompted this: a virtualenv burying the files someone was looking for. */
  it('excludes Python environments by default', () => {
    expect(DEFAULT_MENTION_EXCLUDES).toContain('.venv')
    expect(DEFAULT_MENTION_EXCLUDES).toContain('__pycache__')
  })

  it('uses the defaults when nothing is configured', () => {
    expect(mentionExcludes(undefined)).toEqual(DEFAULT_MENTION_EXCLUDES)
  })

  it('uses exactly what was configured when something is', () => {
    expect(mentionExcludes(['vendor'])).toEqual(['vendor'])
  })

  /**
   * An empty array is a choice, not an absence. Someone who wants to reach into `.venv` has said
   * so, and overriding that would be the picker deciding it knows better.
   */
  it('honours an empty list rather than falling back to the defaults', () => {
    expect(mentionExcludes([])).toEqual([])
    expect(mentionExcludeGlob([])).toBeUndefined()
  })

  it('ignores blank entries left behind by editing', () => {
    expect(mentionExcludes(['vendor', '  ', ''])).toEqual(['vendor'])
  })

  it('builds one brace glob, because findFiles takes a single exclude', () => {
    expect(mentionExcludeGlob(['node_modules', '.venv'])).toBe('**/{node_modules,.venv}/**')
  })
})
