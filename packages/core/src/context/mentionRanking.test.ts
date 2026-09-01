import { describe, expect, it } from 'vitest'

import { compareMentionCandidates } from './mentionRanking.js'

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
