import { describe, expect, it } from 'vitest'

import { clipQuote, composeUserText, MAX_QUOTE_CHARS } from './feedback.js'

describe('replies and reactions as the model reads them', () => {
  it('leaves an ordinary message byte-for-byte alone', () => {
    expect(composeUserText('fix the build')).toBe('fix the build')
    expect(composeUserText('fix the build', { reactions: [] })).toBe('fix the build')
  })

  it('quotes the part replied to above what was typed', () => {
    const text = composeUserText('why not the cache?', { replyTo: { excerpt: 'Use a lock.\nThen retry.', source: 'message' } })
    expect(text).toBe('[Replying to this part of your earlier reply]\n> Use a lock.\n> Then retry.\n\nwhy not the cache?')
  })

  /* Reacting to thinking steers the next step; the model is told the quote is its own reasoning. */
  it('lists reactions first, saying which came from the thought process', () => {
    const text = composeUserText('carry on', {
      reactions: [
        { reaction: 'down', quote: { excerpt: 'rewrite the parser', source: 'reasoning' } },
        { reaction: 'focus', quote: { excerpt: 'the failing test', source: 'message' } },
      ],
    })
    expect(text.startsWith('[My reactions to what you wrote')).toBe(true)
    expect(text).toContain('👎 Wrong, do not pursue this: "rewrite the parser" (from your thought process)')
    expect(text).toContain('🎯 Focus on this: "the failing test"')
    expect(text.endsWith('carry on')).toBe(true)
  })

  it('delivers reactions alone when nothing was typed', () => {
    expect(composeUserText('', { reactions: [{ reaction: 'up', quote: { excerpt: 'x', source: 'message' } }] })).not.toMatch(/\n\n$/)
  })

  /* The panel clips, the host clips again: the two must agree or bubble and transcript differ. */
  it('clips idempotently, ellipsis included', () => {
    const long = 'word '.repeat(600)
    const once = clipQuote(long)
    expect(once.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS)
    expect(once.endsWith('…')).toBe(true)
    expect(clipQuote(once)).toBe(once)
  })
})
