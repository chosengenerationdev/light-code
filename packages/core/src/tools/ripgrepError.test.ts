import { describe, expect, it } from 'vitest'
import { describeRipgrepFailure } from './ripgrepError.js'

/**
 * What a missing ripgrep says to the person reading it.
 *
 * Reported from real use as `rg.exe ENOENT`, which is a raw errno: it names no cause, and gives
 * no action for something a window reload actually fixes.
 */
describe('describeRipgrepFailure', () => {
  const enoent = Object.assign(new Error('spawn rg.exe ENOENT'), { code: 'ENOENT' })

  it('explains a missing binary and says what to do', () => {
    const message = describeRipgrepFailure(enoent, 'Search')
    expect(message).toContain('Search is unavailable')
    expect(message).toContain('Reload Window')
  })

  /* The errno itself is not the message. */
  it('does not hand back the raw spawn error', () => {
    expect(describeRipgrepFailure(enoent, 'Search')).not.toContain('ENOENT')
  })

  it('names the operation, so list_files and search_files read differently', () => {
    expect(describeRipgrepFailure(enoent, 'Listing files recursively')).toContain(
      'Listing files recursively is unavailable',
    )
  })

  /* Anything else is passed through — guessing a cause would send people after the wrong thing. */
  it('leaves an unrelated failure as it found it', () => {
    const message = describeRipgrepFailure(new Error('maxBuffer exceeded'), 'Search')
    expect(message).toBe('Search failed: maxBuffer exceeded')
    expect(message).not.toContain('Reload Window')
  })
})
