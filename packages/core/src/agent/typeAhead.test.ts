import { describe, expect, it } from 'vitest'

import { cleanSuggestion, nextWord, typeAheadMessages, TYPE_AHEAD_MAX_CHARS } from './typeAhead.js'

/** Asked for: grey suggestions while typing, Tab for the next word and Ctrl+Space for all of it. */
describe('suggestions while typing', () => {
  it('keeps only what comes next, on one line', () => {
    expect(cleanSuggestion('fix the failing', ' test in the parser\nand then explain')).toBe(' test in the parser')
    expect(cleanSuggestion('fix the failing', 'fix the failing test')).toBe(' test')
    expect(cleanSuggestion('please look at the failing', 'at the failing test now')).toBe(' test now')
    expect(cleanSuggestion('fix the ', ' failing test')).toBe('failing test')
    expect(cleanSuggestion('fix the', '"failing test"')).toBe('failing test')
    expect(cleanSuggestion('fix the', '   \n')).toBe('')
  })

  it('ends a long suggestion on a whole word', () => {
    const out = cleanSuggestion('write', ` ${'word '.repeat(60)}`)
    expect(out.length).toBeLessThanOrEqual(TYPE_AHEAD_MAX_CHARS)
    expect(out.endsWith('word')).toBe(true)
  })

  it('Tab takes the next word with its leading space', () => {
    expect(nextWord(' test in the parser')).toBe(' test')
    expect(nextWord('parser, please')).toBe('parser,')
    expect(nextWord('end')).toBe('end')
  })

  it('sends the typed text with a little of the conversation, never tool traffic', () => {
    const messages = typeAheadMessages('fix the', [
      { role: 'user', content: 'the parser test fails' },
      { role: 'tool', content: 'SECRET TOOL OUTPUT', toolCallId: 'x' },
      { role: 'assistant', content: 'I found the cause in parse.ts' },
    ] as never)
    const prompt = String(messages[1]?.content)
    expect(prompt).toContain('<<<fix the>>>')
    expect(prompt).toContain('User: the parser test fails')
    expect(prompt).toContain('Assistant: I found the cause')
    expect(prompt).not.toContain('SECRET TOOL OUTPUT')
  })
})
