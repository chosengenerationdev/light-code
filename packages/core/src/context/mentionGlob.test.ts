import { describe, expect, it } from 'vitest'

import { mentionGlob, mentionSegment } from './mentionGlob.js'

/**
 * The picker's pattern, and the two ways it silently matched nothing.
 *
 * Both were measured against the `rg.exe` the extension actually ships, because
 * `vscode.workspace.findFiles` is ripgrep underneath and both claims read as obviously true in
 * either direction. What is asserted here is the *pattern*, since a test cannot run the editor's
 * index — so the expectations below are written to the spellings that were verified to work.
 */
describe('mentionGlob', () => {
  it('matches either case, which is the whole bug', () => {
    /*
     * `**\/*app*` returns nothing for `App.tsx`. Measured. People type lowercase and a real
     * codebase is full of PascalCase filenames, so the picker was blind to a large part of it —
     * reported as "still not finding many files in my local code base".
     */
    expect(mentionGlob('app')).toBe('**/*[aA][pP][pP]*')
    // And the other direction, because somebody typing the real name must still find it.
    expect(mentionGlob('App')).toBe('**/*[aA][pP][pP]*')
  })

  it('leaves digits and ordinary punctuation as themselves', () => {
    expect(mentionGlob('v2.ts')).toBe('**/*[vV]2.[tT][sS]*')
  })

  it('escapes glob syntax the user typed, so a literal name stays literal', () => {
    /*
     * `**\/*data[1]*` is a character class and matches nothing; `**\/*data\[1\]*` matches the
     * file. So the picker went empty exactly when somebody was being most specific.
     */
    expect(mentionGlob('data[1]')).toBe('**/*[dD][aA][tT][aA]\\[1\\]*')
    expect(mentionGlob('a{b}')).toBe('**/*[aA]\\{[bB]\\}*')
    expect(mentionGlob('q?x')).toBe('**/*[qQ]\\?[xX]*')
    // A `*` somebody typed is text, not "everything" — they are naming a file, not writing a glob.
    expect(mentionGlob('a*b')).toBe('**/*[aA]\\*[bB]*')
  })

  it('asks for everything when nothing has been typed yet', () => {
    // `@` on its own, or `@src/`. The ranking then decides what to show.
    expect(mentionGlob('')).toBe('**/*')
  })

  it('never emits an unescaped bracket or brace for any printable input', () => {
    // A blanket check, because the failure is silent: a stray metacharacter does not error, it
    // simply matches nothing, and no test of one example would notice a character nobody listed.
    const printable = Array.from({ length: 95 }, (_, at) => String.fromCharCode(32 + at)).join('')
    const body = mentionGlob(printable).slice('**/*'.length, -1)
    // Strip the case classes this deliberately emits, then nothing bracket-shaped may remain
    // unescaped.
    const rest = body.replace(/\[[a-z][A-Z]\]/g, '')
    expect(rest).not.toMatch(/(^|[^\\])[[\]{}?*!]/)
  })
})

describe('mentionSegment', () => {
  it('takes the last segment, because a glob cannot cross a separator', () => {
    expect(mentionSegment('src/api')).toBe('api')
    // Windows separators arrive too — somebody pasting a path types what their shell prints.
    expect(mentionSegment('src\\api')).toBe('api')
    expect(mentionSegment('api')).toBe('api')
  })

  it('is empty for a trailing separator, which means "everything under here"', () => {
    expect(mentionSegment('src/')).toBe('')
    expect(mentionSegment('')).toBe('')
  })
})
