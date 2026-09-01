import { describe, expect, it } from 'vitest'

import { splitMentions } from './mentions.js'

/**
 * The composer draws its text twice — once plainly in a layer that colours mentions, once in
 * the textarea above it with transparent glyphs. The two only line up while they contain the
 * same characters, so what this really pins is that segmentation is lossless.
 */
const rejoin = (text: string): string => splitMentions(text).map((segment) => segment.text).join('')

describe('highlighting @ mentions in the composer', () => {
  it('marks a mention and leaves the prose around it alone', () => {
    expect(splitMentions('look at @src/api.ts please')).toEqual([
      { text: 'look at ', isMention: false },
      { text: '@src/api.ts', isMention: true },
      { text: ' please', isMention: false },
    ])
  })

  it('keeps a quoted path with spaces in one piece', () => {
    const segments = splitMentions('open @"my docs/notes.md" now')
    expect(segments.filter((segment) => segment.isMention).map((segment) => segment.text)).toEqual([
      '@"my docs/notes.md"',
    ])
  })

  it('marks several mentions in a long prompt', () => {
    const segments = splitMentions('compare @a/one.ts with @b/two.ts and @c/three.ts')
    expect(segments.filter((segment) => segment.isMention)).toHaveLength(3)
  })

  /** A bare `@` is mid-typing, or an email, or a handle. Colouring it flickers on every message. */
  it('does not treat a lone @ as a mention', () => {
    expect(splitMentions('email me @ work').every((segment) => !segment.isMention)).toBe(true)
  })

  it('never loses or adds a character, whatever the input', () => {
    for (const text of [
      '',
      '@',
      '@a',
      'plain text with no mentions at all',
      '@start of line',
      'ends with a mention @src/x.ts',
      'newlines\nand @paths/y.ts\nmixed',
      '@"quoted one.md" then @unquoted.md',
      'punctuation: @a.ts, @b.ts.',
    ]) {
      expect(rejoin(text)).toBe(text)
    }
  })
})
