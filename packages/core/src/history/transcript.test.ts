import { describe, expect, it } from 'vitest'

import { formatToolArguments, toolCallReason } from './transcript.js'


/**
 * The reason is lifted out of the arguments so the collapsed tool row can carry it. It must not
 * then appear twice, and it must never be invented — an absent reason is absent, not guessed.
 */
describe('the reason a tool was called', () => {
  it('is read from the call and kept out of the argument listing', () => {
    const raw = JSON.stringify({ path: 'src/api.ts', why: 'checking which gateway it points at' })
    expect(toolCallReason(raw)).toBe('checking which gateway it points at')
    expect(formatToolArguments(raw)).not.toContain('why')
    expect(formatToolArguments(raw)).toContain('src/api.ts')
  })

  it('is absent when the model gave none', () => {
    expect(toolCallReason(JSON.stringify({ path: 'a.ts' }))).toBeUndefined()
    expect(toolCallReason('')).toBeUndefined()
    expect(toolCallReason('not json')).toBeUndefined()
  })

  it('is absent rather than blank when it is empty or the wrong type', () => {
    expect(toolCallReason(JSON.stringify({ why: '  ' }))).toBeUndefined()
    expect(toolCallReason(JSON.stringify({ why: 12 }))).toBeUndefined()
  })

  /** Malformed arguments still have to render: the user needs to see what was actually sent. */
  it('leaves unparseable arguments alone', () => {
    expect(formatToolArguments('{oops')).toBe('{oops')
  })
})
