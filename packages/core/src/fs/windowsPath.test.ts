import { describe, expect, it } from 'vitest'

import { normalizeWindowsPath } from './windowsPath.js'

const B = '\\'
const win = (value: string): string => normalizeWindowsPath(value, 'win32')

describe('normalizeWindowsPath', () => {
  /**
   * The reported case, reproduced exactly.
   *
   * The model JSON-escaped an already-escaped path, so eight backslashes arrived in the source
   * and four survived parsing. `path.resolve` does not read four as UNC, so it produced a
   * `C:\` path the user had never mentioned.
   */
  it('repairs a UNC path that arrived with four leading backslashes', () => {
    const mangled = `${B}${B}${B}${B}nas.apac.net.intra${B}${B}sg${B}${B}prd${B}${B}file.html`
    expect(win(mangled)).toBe(`${B}${B}nas.apac.net.intra${B}sg${B}prd${B}file.html`)
  })

  it('leaves a correctly written UNC path alone', () => {
    const good = `${B}${B}server${B}share${B}a.log`
    expect(win(good)).toBe(good)
  })

  it('collapses doubled separators inside a drive path', () => {
    expect(win(`C:${B}${B}Users${B}${B}me${B}a.txt`)).toBe(`C:${B}Users${B}me${B}a.txt`)
  })

  /**
   * One leading separator is drive-relative and legitimate. Promoting it to two would invent a
   * server name and point the read somewhere entirely different.
   */
  it('does not turn a drive-relative path into a UNC one', () => {
    expect(win(`${B}folder${B}file.txt`)).toBe(`${B}folder${B}file.txt`)
  })

  it('leaves an ordinary relative path untouched', () => {
    expect(win('src/index.ts')).toBe('src/index.ts')
    expect(win(`src${B}index.ts`)).toBe(`src${B}index.ts`)
  })

  it('handles the empty string', () => {
    expect(win('')).toBe('')
  })

  /**
   * On POSIX a backslash is an ordinary filename character, so collapsing one would corrupt a
   * real name rather than repair a broken one.
   */
  it('changes nothing on POSIX', () => {
    const odd = `a${B}${B}b`
    expect(normalizeWindowsPath(odd, 'linux')).toBe(odd)
    expect(normalizeWindowsPath(`${B}${B}${B}${B}srv${B}${B}x`, 'darwin')).toBe(`${B}${B}${B}${B}srv${B}${B}x`)
  })

  it('accepts a forward-slash UNC path as Windows writes it', () => {
    // `path.resolve` normalises the slashes; what matters is that the prefix survives as two.
    expect(win('////server//share/a.log')).toBe(`${B}${B}server//share/a.log`)
  })
})
