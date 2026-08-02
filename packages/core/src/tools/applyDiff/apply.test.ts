import { describe, expect, it } from 'vitest'
import { applyDiff } from './apply.js'

function diffBlock(search: string, replace: string, startLine?: number): string {
  const header = startLine !== undefined ? `<<<<<<< SEARCH\n:start_line:${startLine}\n-------\n` : '<<<<<<< SEARCH\n'
  return `${header}${search}\n=======\n${replace}\n>>>>>>> REPLACE`
}

describe('applyDiff — exact match', () => {
  it('replaces a uniquely-matching block', () => {
    const original = 'line1\nline2\nline3\n'
    const result = applyDiff(original, diffBlock('line2', 'LINE2'))

    expect(result.ok).toBe(true)
    expect(result.content).toBe('line1\nLINE2\nline3\n')
  })
})

describe('applyDiff — whitespace-insensitive tier', () => {
  it('matches despite different indentation and applies using the file\'s real indentation', () => {
    const original = 'function foo() {\n    return 1;\n}\n'
    // SEARCH uses 2-space indent; the file actually uses 4.
    const result = applyDiff(original, diffBlock('  return 1;', '  return 2;'))

    expect(result.ok).toBe(true)
    expect(result.content).toBe('function foo() {\n    return 2;\n}\n')
  })
})

describe('applyDiff — anchor tier (5+ line blocks)', () => {
  it('matches on a 6-line block via first/last line when one interior line has drifted', () => {
    const original = 'AAA\nBBB\nCCC-changed\nDDD\nEEE\nFFF\n'
    const search = 'AAA\nBBB\nCCC-original\nDDD\nEEE\nFFF'
    const replace = 'AAA\nBBB\nCCC-original\nDDD\nEEE\nGGG'
    const result = applyDiff(original, diffBlock(search, replace))

    expect(result.ok).toBe(true)
    expect(result.content).toBe('AAA\nBBB\nCCC-original\nDDD\nEEE\nGGG\n')
  })

  it('does not use the anchor tier for blocks under 5 lines', () => {
    // 3 lines, interior drifted — must fail rather than silently anchor-matching.
    const original = 'AAA\nchanged\nCCC\n'
    const search = 'AAA\noriginal\nCCC'
    const result = applyDiff(original, diffBlock(search, 'replacement'))

    expect(result.ok).toBe(false)
  })
})

describe('applyDiff — CRLF files', () => {
  it('detects CRLF, matches against LF-normalized content, and restores CRLF on write', () => {
    const original = 'line1\r\nline2\r\nline3\r\n'
    const result = applyDiff(original, diffBlock('line2', 'LINE2'))

    expect(result.ok).toBe(true)
    expect(result.content).toBe('line1\r\nLINE2\r\nline3\r\n')
  })
})

describe('applyDiff — uniqueness', () => {
  it('rejects a SEARCH block that matches more than one location', () => {
    const original = 'dup\nmiddle\ndup\n'
    const result = applyDiff(original, diffBlock('dup', 'unique'))

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/matches 2 locations/)
    // Nothing should have been changed.
    expect(result.content).toBe(original)
  })

  it('disambiguates an otherwise-non-unique match using the :start_line: hint', () => {
    const original = 'dup\nmiddle\ndup\n'
    const result = applyDiff(original, diffBlock('dup', 'unique', 3))

    expect(result.ok).toBe(true)
    expect(result.content).toBe('dup\nmiddle\nunique\n')
  })
})

describe('applyDiff — malformed blocks', () => {
  it('rejects a block missing the ======= separator with a useful message', () => {
    const original = 'line1\n'
    // Truncated mid-SEARCH-section: no separator and no replace marker anywhere.
    const malformed = '<<<<<<< SEARCH\nline1'
    const result = applyDiff(original, malformed)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('=======')
    expect(result.content).toBe(original)
  })

  it('rejects a REPLACE marker appearing before any ======= separator', () => {
    const original = 'line1\n'
    const malformed = '<<<<<<< SEARCH\nline1\n>>>>>>> REPLACE'
    const result = applyDiff(original, malformed)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Unexpected marker')
    expect(result.content).toBe(original)
  })

  it('rejects a marker appearing inside the REPLACE section', () => {
    const original = 'line1\n'
    const malformed = '<<<<<<< SEARCH\nline1\n=======\n:start_line:1\nreplacement\n>>>>>>> REPLACE'
    const result = applyDiff(original, malformed)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Unexpected marker')
  })

  it('rejects a SEARCH that is not found, including the current text near the hint', () => {
    const original = 'AAA\nBBB\nCCC\n'
    const result = applyDiff(original, diffBlock('does not exist', 'x', 2))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not found')
    expect(result.message).toContain('Current content near line 2')
  })
})

describe('applyDiff — multiple blocks, all-or-nothing', () => {
  it('applies every block in one call when all are valid', () => {
    const original = 'one\ntwo\nthree\n'
    const diff = `${diffBlock('one', 'ONE')}\n\n${diffBlock('three', 'THREE')}`
    const result = applyDiff(original, diff)

    expect(result.ok).toBe(true)
    expect(result.content).toBe('ONE\ntwo\nTHREE\n')
  })

  it('applies no blocks at all if any single block fails validation', () => {
    const original = 'one\ntwo\nthree\n'
    const diff = `${diffBlock('one', 'ONE')}\n\n${diffBlock('does not exist', 'X')}`
    const result = applyDiff(original, diff)

    expect(result.ok).toBe(false)
    expect(result.content).toBe(original)
  })
})
