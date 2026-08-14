import { describe, expect, it } from 'vitest'
import { activeMentionQuery, insertMention, renderMention } from './mentions.js'

/**
 * Shared by the composer and the schedule editor, which is why it is worth testing directly:
 * the caret arithmetic is small but exacting, and "the cursor ended up in the wrong place" is
 * invisible until someone types into it.
 */
describe('activeMentionQuery', () => {
  it('reports the partial mention at the caret', () => {
    expect(activeMentionQuery('look at @src/ap', 15)).toBe('src/ap')
  })

  it('is undefined with no mention before the caret', () => {
    expect(activeMentionQuery('nothing here', 12)).toBeUndefined()
  })

  /** Otherwise typing an email address opens a file picker and leaves it open all line. */
  it('closes on a space', () => {
    expect(activeMentionQuery('@src/app.ts and then', 20)).toBeUndefined()
  })

  /**
   * A second @ starts a *new* mention rather than closing the old one, because the search
   * runs backwards from the caret. That is what you want while typing two in a row — the
   * picker follows the one being written.
   */
  it('tracks the most recent @, not the first', () => {
    expect(activeMentionQuery('@a@b', 4)).toBe('b')
  })

  it('is empty immediately after the @, so the picker opens', () => {
    expect(activeMentionQuery('read @', 6)).toBe('')
  })

  /** Only what precedes the caret counts — editing mid-sentence must not scan forwards. */
  it('ignores text after the caret', () => {
    expect(activeMentionQuery('@src later words', 4)).toBe('src')
  })
})

describe('renderMention', () => {
  it('quotes a path containing spaces so it reads as one target', () => {
    expect(renderMention('my docs/notes.md')).toBe('@"my docs/notes.md"')
    expect(renderMention('src/app.ts')).toBe('@src/app.ts')
  })
})

describe('insertMention', () => {
  it('replaces the partial mention and leaves the caret after it', () => {
    const result = insertMention('look at @src/ap', 15, 'src/app.ts')
    expect(result?.text).toBe('look at @src/app.ts ')
    expect(result?.caret).toBe(result?.text.length)
  })

  /**
   * The case the obvious shortcut gets wrong. Putting the caret at the end of the text is
   * fine until someone inserts a mention into the middle of a sentence they already wrote.
   */
  it('keeps the text after the caret, and lands the caret before it', () => {
    const result = insertMention('check @src and tell me', 10, 'src/app.ts')
    expect(result?.text).toBe('check @src/app.ts  and tell me')
    expect(result?.text.slice(result.caret)).toBe(' and tell me')
  })

  it('does nothing when there is no mention to replace', () => {
    expect(insertMention('no mention here', 5, 'src/app.ts')).toBeUndefined()
  })
})
