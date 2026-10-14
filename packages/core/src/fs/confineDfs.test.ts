import { describe, expect, it } from 'vitest'

import { asWrittenWhenRedirected } from './confine.js'

/**
 * Reported from real use: a DFS share was "access denied" while a plain NAS share worked, for the
 * share's owner. `realpath` answers a DFS path with the server behind it, and every tool then opened
 * that target directly. No DFS namespace can be made on a test machine, so these drive the shipped
 * function with the path pairs Windows produces.
 */
describe('a network redirect (DFS) is not followed to another server', () => {
  it('keeps a DFS path as written when it resolves onto another server or share', async () => {
    expect(await asWrittenWhenRedirected('\\\\corp.example\\dfs\\team\\report.xlsx', '\\\\?\\UNC\\fs01.corp.example\\team$\\report.xlsx')).toBe(
      '\\\\corp.example\\dfs\\team\\report.xlsx',
    )
    expect(await asWrittenWhenRedirected('\\\\corp.example\\dfs\\team', '\\\\fs01.corp.example\\team$')).toBe('\\\\corp.example\\dfs\\team')
  })

  it('still follows an ordinary resolution within the same share', async () => {
    expect(await asWrittenWhenRedirected('\\\\nas01\\data\\Logs\\a.log', '\\\\nas01\\data\\logs\\a.log')).toBe('\\\\nas01\\data\\logs\\a.log')
    expect(await asWrittenWhenRedirected('\\\\nas01\\data\\link\\a.log', '\\\\?\\UNC\\nas01\\data\\real\\a.log')).toBe('\\\\?\\UNC\\nas01\\data\\real\\a.log')
  })

  it('judges a local path by where it lands, so a link in the workspace cannot reach a share unseen', async () => {
    expect(await asWrittenWhenRedirected('C:\\work\\link\\a.txt', 'C:\\elsewhere\\a.txt')).toBe('C:\\elsewhere\\a.txt')
    // C: is not a mapped network drive on any machine running this, so a UNC landing is followed.
    expect(await asWrittenWhenRedirected('C:\\work\\link\\a.txt', '\\\\server\\share\\a.txt')).toBe('\\\\server\\share\\a.txt')
  })
})
