import { describe, expect, it } from 'vitest'

import { compareMentionCandidates, matchesMentionQuery } from './mentionRanking.js'

/**
 * Reported as "when I use @ it is not showing some files which I expect to see".
 *
 * The search was never the problem — the picker asked the file index for thirty matches and
 * showed those thirty, and an index returns them in its own order. So in any real repository
 * the truncation, not the query, decided what you saw. These pin the order that replaced it.
 */
const order = (query: string, candidates: string[]): string[] => [...candidates].sort(compareMentionCandidates(query))

describe('the @ picker order', () => {
  it('puts a file named for the query above files merely inside a folder of that name', () => {
    const ranked = order('auth', [
      'src/auth/handlers/session-store-implementation.ts',
      'src/auth/handlers/tokens.ts',
      'src/auth.ts',
    ])
    expect(ranked[0]).toBe('src/auth.ts')
  })

  it('prefers a name that starts with the query over one that merely contains it', () => {
    expect(order('api', ['src/legacy-api-client.ts', 'src/api-client.ts'])[0]).toBe('src/api-client.ts')
  })

  it('prefers the shallower of two equally good matches', () => {
    const ranked = order('config', ['a/b/c/d/config.ts', 'config.ts'])
    expect(ranked[0]).toBe('config.ts')
  })

  /** The case that made this worth fixing: the wanted file is not the shortest path. */
  it('finds an exact name among many longer paths that also match', () => {
    const noise = Array.from({ length: 50 }, (_, index) => `packages/generated/module${String(index)}/user.ts`)
    expect(order('user', [...noise, 'src/models/user.ts'])[0]).toBe('src/models/user.ts')
  })

  it('is stable and alphabetical when nothing else separates two candidates', () => {
    expect(order('x', ['b/x.ts', 'a/x.ts'])).toEqual(['a/x.ts', 'b/x.ts'])
  })

  it('falls back to shallow-and-short when there is no query yet', () => {
    expect(order('', ['deep/deeper/a.ts', 'a.ts'])[0]).toBe('a.ts')
  })

  it('ignores case, since nobody types the capitals', () => {
    expect(order('readme', ['docs/notes/readme-template.md', 'README.md'])[0]).toBe('README.md')
  })
})

/**
 * "When I typed @ it is still struggling to find the file I need", after ranking was added.
 *
 * The ranking was fine; the *glob* was not. `*` does not cross a path separator, so the obvious
 * whole-query pattern matched almost nothing the moment someone typed a path — the picker went
 * emptiest exactly when they were being most specific. The glob now asks about the last segment
 * only and this decides the rest.
 */
describe('which candidates are plausible at all', () => {
  const keep = (query: string, candidates: string[]): string[] => candidates.filter(matchesMentionQuery(query))

  it('accepts a path fragment spanning a separator', () => {
    expect(keep('src/api', ['src/api.ts', 'lib/other.ts'])).toEqual(['src/api.ts'])
  })

  it('ignores separators, so the same query works typed either way', () => {
    expect(keep('srcapi', ['src/api.ts'])).toEqual(['src/api.ts'])
    expect(keep('src\\api', ['src/api.ts'])).toEqual(['src/api.ts'])
  })

  /** People type the letters they remember, in order, and skip the rest. */
  it('matches letters in order rather than a contiguous run', () => {
    expect(keep('mrank', ['context/mentionRanking.ts'])).toEqual(['context/mentionRanking.ts'])
    expect(keep('cfgsch', ['config/schema.ts'])).toEqual(['config/schema.ts'])
  })

  it('still rejects a file that has nothing to do with the query', () => {
    expect(keep('mrank', ['docs/hosting.md'])).toEqual([])
  })

  it('rejects letters that appear only out of order', () => {
    expect(keep('ba', ['a/b.ts'])).toEqual([])
  })

  it('keeps everything when nothing has been typed yet', () => {
    expect(keep('', ['a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts'])
  })

  it('ignores case, since nobody types the capitals', () => {
    expect(keep('readme', ['README.md'])).toEqual(['README.md'])
  })
})
