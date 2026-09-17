import { describe, expect, it } from 'vitest'

import type { VectorMatch, VectorSearcher, VectorSearchOptions } from '../rag/vectorStore.js'
import { createSearchCodebaseTool, describeOrigin } from './searchCodebase.js'
import type { ToolExecutionContext } from './types.js'

/**
 * Searching a team's shared index without misleading the model about what it can open.
 *
 * User-requested, and the constraint was stated as the requirement rather than as a detail:
 * "more importantly LLM model should not get confused with code it finds in the search and it
 * doesn't find it in the local as it belongs to different user or project".
 *
 * The design that answers it is that **locality is checked on disk, never inferred from the
 * owner field**. Attribution is metadata: absent on anything indexed before it existed, and
 * wrong the moment two people configure the same index name. Whether `read_file` will succeed
 * is a fact about this filesystem, so the tool asks the filesystem.
 */

function searcher(hits: VectorMatch[], record?: (options: VectorSearchOptions & { collection: string }) => void): VectorSearcher {
  return {
    kind: 'opensearch',
    label: 'test cluster',
    searchByVector: async (collection, _vector, options) => {
      record?.({ ...options, collection })
      return hits
    },
  }
}

/** A workspace where only the paths listed actually exist. */
function context(present: string[]): ToolExecutionContext {
  return {
    workspaceRoot: '/repo',
    fs: {
      exists: async (candidate: string) =>
        present.some((entry) => candidate.replace(/\\/g, '/').endsWith(entry)),
    },
  } as unknown as ToolExecutionContext
}

const embedder = { embed: async () => [0.1], dimensions: 1 } as never

function tool(hits: VectorMatch[], extra: Record<string, unknown> = {}, record?: never) {
  return createSearchCodebaseTool({
    searcher: searcher(hits, record),
    embedder,
    index: 'lc-mine',
    connectionLabel: 'test cluster',
    ...extra,
  } as never)
}

const mine: VectorMatch = { id: 'a', score: 0.9, text: 'mine()', path: 'src/mine.ts', owner: 'me', project: 'app' }
const theirs: VectorMatch = { id: 'b', score: 0.8, text: 'theirs()', path: 'src/theirs.ts', owner: 'r.silva', project: 'billing' }

describe('a hit that is not on this machine', () => {
  it('is marked, and the marking comes from the filesystem rather than the owner field', async () => {
    // `theirs` claims another owner but IS present here; `mine` claims to be mine and is NOT.
    const result = await tool([mine, theirs], { owner: 'me', teamAliases: ['team'] }).execute(
      { query: 'x', scope: 'team' },
      context(['src/theirs.ts']),
    )

    const [first, second] = result.content.split('---')
    expect(first).toContain('NOT IN THIS WORKSPACE')
    expect(second).not.toContain('NOT IN THIS WORKSPACE')
  })

  it('tells the model not to try opening it', async () => {
    const result = await tool([theirs], { owner: 'me', teamAliases: ['team'] }).execute(
      { query: 'x', scope: 'team' },
      context([]),
    )

    expect(result.content).toContain('Do not call read_file')
    expect(result.content).toContain('NOT IN THIS WORKSPACE')
  })

  /** The guidance is noise when everything is openable, and noise trains people to skip it. */
  it('says nothing about remote files when every hit is local', async () => {
    const result = await tool([mine], { owner: 'me' }).execute({ query: 'x' }, context(['src/mine.ts']))

    expect(result.content).not.toContain('Do not call read_file')
    expect(result.content).not.toContain('NOT IN THIS WORKSPACE')
  })
})

describe('choosing what to search', () => {
  it('searches the team alias only when team scope is asked for', async () => {
    const seen: string[] = []
    const probe: VectorSearcher = {
      kind: 'opensearch',
      label: 'test cluster',
      searchByVector: async (collection) => {
        seen.push(collection)
        return []
      },
    }
    const built = createSearchCodebaseTool({
      searcher: probe,
      embedder,
      index: 'lc-mine',
      connectionLabel: 'test cluster',
      teamAliases: ['team-all'],
      owner: 'me',
    } as never)

    await built.execute({ query: 'x' }, context([]))
    await built.execute({ query: 'x', scope: 'team' }, context([]))

    expect(seen).toEqual(['lc-mine', 'team-all'])
  })

  /**
   * "Mine" stays mine even against an index someone else also writes to. Two checkouts can be
   * configured with the same index name, and a "mine" that quietly included a colleague's is
   * the confusion this whole change exists to remove.
   */
  it('narrows to this owner whenever it is not deliberately searching the team', async () => {
    const seen: (string | undefined)[] = []
    const probe: VectorSearcher = {
      kind: 'opensearch',
      label: 'test cluster',
      searchByVector: async (_collection, _vector, options) => {
        seen.push(options.owner)
        return []
      },
    }
    const built = createSearchCodebaseTool({
      searcher: probe,
      embedder,
      index: 'lc-mine',
      connectionLabel: 'test cluster',
      teamAliases: ['team-all'],
      owner: 'me',
    } as never)

    await built.execute({ query: 'x' }, context([]))
    await built.execute({ query: 'x', scope: 'team' }, context([]))

    expect(seen).toEqual(['me', undefined])
  })

  /**
   * Asking for the team without one configured must not read as "nobody has done this".
   * Degrading silently is what produces a confident wrong answer.
   */
  it('says so when team scope was asked for but is not configured', async () => {
    const result = await tool([mine], { owner: 'me' }).execute(
      { query: 'x', scope: 'team' },
      context(['src/mine.ts']),
    )

    expect(result.content).toContain('none is configured')
    expect(result.content).toContain('their work was not looked at')
  })
})

describe('labelling where a hit came from', () => {
  it('stays silent about your own work, which is nearly all of it', () => {
    expect(describeOrigin('me', undefined, 'me')).toBe('')
  })

  it('still distinguishes two of your own projects', () => {
    expect(describeOrigin('me', 'billing', 'me')).toBe('  [billing]')
  })

  it('names someone else', () => {
    expect(describeOrigin('r.silva', 'billing', 'me')).toBe('  [r.silva / billing]')
  })

  /** Predates attribution. Unknown is not "yours", and saying so would be the same mistake. */
  it('calls an unattributed chunk unknown rather than yours', () => {
    expect(describeOrigin(undefined, 'billing', 'me')).toBe('  [unknown owner / billing]')
  })

  it('says nothing when there is nothing to say', () => {
    expect(describeOrigin(undefined, undefined, 'me')).toBe('')
  })
})

/**
 * Several aliases on one index, which is what makes levels of sharing possible.
 *
 * With one name there is one circle and you are either in it or out of it. An index may carry
 * several — a squad, a department, everyone — and each is a scope somebody can search.
 */
describe('named scopes', () => {
  /** Which collection the request actually went to, recorded through the searcher. */
  async function searchedFor(scope: string): Promise<string | undefined> {
    let collection: string | undefined
    const instrumented = createSearchCodebaseTool({
      searcher: searcher([mine], (options) => {
        collection = options.collection
      }),
      embedder,
      index: 'lc-mine',
      connectionLabel: 'test cluster',
      owner: 'me',
      teamAliases: ['my-squad', 'everyone'],
    } as never)
    await instrumented.execute({ query: 'x', scope } as never, context(['src/mine.ts']))
    return collection
  }

  it('searches the alias the scope names', async () => {
    expect(await searchedFor('everyone')).toBe('everyone')
  })

  /* So a single-alias install behaves exactly as it did before scopes could be named. */
  it('treats "team" as the first, which is the default circle', async () => {
    expect(await searchedFor('team')).toBe('my-squad')
  })

  it('stays in this workspace for "mine"', async () => {
    expect(await searchedFor('mine')).toBe('lc-mine')
  })

  /*
   * A near-miss must never resolve to a different circle — that would show somebody a group they
   * are not in, which is the one failure this cannot have. So it is reported, and the message
   * names what does exist, which turns a dead end into a retry the model can get right.
   */
  it('refuses a scope it does not have, and says which it does', async () => {
    const result = await tool([mine], {
      owner: 'me',
      teamAliases: ['my-squad', 'everyone'],
    }).execute({ query: 'x', scope: 'my-squd' } as never, context(['src/mine.ts']))
    expect(result.content).toContain('no shared scope called "my-squd"')
    expect(result.content).toContain('my-squad, everyone')
  })
})
