import { describe, expect, it } from 'vitest'

import { findTeamSkillsNamed, renderTeamSkillHits, searchTeamSkills } from './teamSkills.js'
import type { VectorMatch, VectorSearcher } from './vectorStore.js'

/**
 * Widening a skills search through the alias list.
 *
 * Asked for directly: if a skill is not in the first alias, try the next. The list is ordered
 * most-specific-first — a squad, a department, everyone — so this is "prefer the nearest circle,
 * widen only when it has nothing".
 *
 * **What it deliberately does not do is judge relevance.** A nearest-neighbour search returns its
 * neighbours whether or not they are any good, so "empty" here means the alias holds nothing, not
 * "my squad has nothing on this subject". Falling through on a low score would need a threshold on
 * embedding distance, which is not comparable between models and would silently prefer a
 * stranger's skill over the squad's own.
 */

const embedder = { embed: async () => [0.1], dimensions: 1 } as never

const match = (name: string, owner: string): VectorMatch => ({
  id: name,
  score: 0.9,
  text: 'body',
  path: `skill:${name}`,
  owner,
})

/** A cluster where only the named aliases hold anything; the rest answer empty. */
const cluster = (byCollection: Record<string, VectorMatch[]>, missing: string[] = []): VectorSearcher & { asked: string[] } => {
  const asked: string[] = []
  return {
    kind: 'opensearch',
    label: 'cluster',
    asked,
    searchByVector: async (collection: string) => {
      asked.push(collection)
      if (missing.includes(collection)) throw new Error(`no such index [${collection}]`)
      return byCollection[collection] ?? []
    },
  } as VectorSearcher & { asked: string[] }
}

describe('searching several aliases', () => {
  it('stops at the first that has anything', async () => {
    const searcher = cluster({ squad: [match('deploy', 'r.silva')], everyone: [match('other', 'x')] })
    const found = await searchTeamSkills({ searcher, embedder, collections: ['squad', 'everyone'] }, 'deploy')

    expect(found.hits.map((h) => h.name)).toEqual(['deploy'])
    expect(found.collection).toBe('squad')
    expect(searcher.asked).toEqual(['squad'])
  })

  it('widens to the next when the first holds nothing', async () => {
    const searcher = cluster({ squad: [], everyone: [match('deploy', 'r.silva')] })
    const found = await searchTeamSkills({ searcher, embedder, collections: ['squad', 'everyone'] }, 'deploy')

    expect(found.collection).toBe('everyone')
    expect(searcher.asked).toEqual(['squad', 'everyone'])
  })

  /* An agreed name nobody has attached an index to is the ordinary way this fails. */
  it('steps over an alias that does not exist yet', async () => {
    const searcher = cluster({ everyone: [match('deploy', 'r.silva')] }, ['squad'])
    const found = await searchTeamSkills({ searcher, embedder, collections: ['squad', 'everyone'] }, 'deploy')

    expect(found.collection).toBe('everyone')
  })

  /*
   * But an unreachable cluster is not "no skills". Answering "nobody has written one" would send
   * somebody off to write a skill when the fix is a connection.
   */
  it('reports the failure when every alias errored', async () => {
    const searcher = cluster({}, ['squad', 'everyone'])
    await expect(
      searchTeamSkills({ searcher, embedder, collections: ['squad', 'everyone'] }, 'deploy'),
    ).rejects.toThrow(/no such index/)
  })

  it('says nothing was found when the aliases are simply empty', async () => {
    const searcher = cluster({ squad: [], everyone: [] })
    const found = await searchTeamSkills({ searcher, embedder, collections: ['squad', 'everyone'] }, 'deploy')

    expect(found.hits).toEqual([])
    expect(found.collection).toBeUndefined()
    expect(found.tried).toEqual(['squad', 'everyone'])
  })
})

describe('what the model is told about where a skill came from', () => {
  it('says which circle answered when the search widened', () => {
    const rendered = renderTeamSkillHits(
      {
        hits: [{ name: 'deploy', text: 'body', score: 1, isMine: false, owner: 'r.silva' }],
        collection: 'everyone',
        tried: ['squad', 'everyone'],
      },
      'deploy',
    )
    expect(rendered).toContain('Nothing in squad')
    expect(rendered).toContain('from everyone')
  })

  /* On the ordinary path that sentence would be noise. */
  it('says nothing extra when the first alias answered', () => {
    const rendered = renderTeamSkillHits(
      {
        hits: [{ name: 'deploy', text: 'body', score: 1, isMine: false, owner: 'r.silva' }],
        collection: 'squad',
        tried: ['squad'],
      },
      'deploy',
    )
    expect(rendered).not.toContain('Nothing in')
  })

  it('names what was looked in when nothing was found', () => {
    const rendered = renderTeamSkillHits({ hits: [], collection: undefined, tried: ['squad', 'everyone'] }, 'deploy')
    expect(rendered).toContain('Looked in squad, everyone')
  })
})

/**
 * Collision detection asks a different question and so walks the list differently.
 *
 * A search wants *an* answer and the nearest circle is the best one. "Is this name taken" is about
 * the whole pool: stopping at the first squad with any skills at all would answer "no collision"
 * while a colleague one circle out owns that exact name.
 */
describe('checking whether a name is already taken', () => {
  it('keeps looking past an alias that answered, unlike a search', async () => {
    const searcher = cluster({
      squad: [match('something-else', 'a.patel')],
      everyone: [match('deploy', 'r.silva')],
    })
    const found = await findTeamSkillsNamed({ searcher, embedder, collections: ['squad', 'everyone'] }, 'deploy')

    expect(found.map((entry) => entry.owner)).toEqual(['r.silva'])
    expect(searcher.asked).toEqual(['squad', 'everyone'])
  })

  /* Overlapping aliases include the same index twice; that is one collision, not two. */
  it('reports one collision when aliases overlap', async () => {
    const searcher = cluster({ squad: [match('deploy', 'r.silva')], everyone: [match('deploy', 'r.silva')] })
    const found = await findTeamSkillsNamed({ searcher, embedder, collections: ['squad', 'everyone'] }, 'deploy')

    expect(found).toHaveLength(1)
  })

  /* A name nobody has published to cannot hold a collision, and must not block a skill. */
  it('does not fail over an alias that does not exist', async () => {
    const searcher = cluster({ everyone: [match('deploy', 'r.silva')] }, ['squad'])
    const found = await findTeamSkillsNamed({ searcher, embedder, collections: ['squad', 'everyone'] }, 'deploy')

    expect(found).toHaveLength(1)
  })
})
