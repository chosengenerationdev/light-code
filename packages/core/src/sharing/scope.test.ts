import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { ChromaSearcher } from '../rag/chroma/chroma.js'
import { OpenSearchClient } from '../rag/opensearch/client.js'
import { QdrantSearcher } from '../rag/qdrant/qdrant.js'
import { searchTeamSkills } from '../rag/teamSkills.js'
import type { VectorSearchOptions } from '../rag/vectorStore.js'
import type { Skill } from '../skills/index.js'
import { runDocsSearch } from '../tools/searchDocs.js'
import type { Tool } from '../tools/types.js'
import { inSearchScope, resolveSearchScope } from './scope.js'

/**
 * Searches default to this project's skills and tools, and go wider, or elsewhere, or to one
 * author's work, when asked. Several teams share one bucket and one cluster.
 */

describe('what a scope includes', () => {
  const here = resolveSearchScope({}, ['Payments', 'pay-api'])

  it('by default: this project under either of its names, and anything with no project', () => {
    expect(inSearchScope({ project: 'payments' }, here)).toBe(true)
    expect(inSearchScope({ project: 'pay-api' }, here)).toBe(true)
    expect(inSearchScope({}, here)).toBe(true)
    expect(inSearchScope({ project: 'Lending' }, here)).toBe(false)
  })

  it('"all" means every project; a named one means exactly that one', () => {
    expect(inSearchScope({ project: 'Lending' }, resolveSearchScope({ project: 'all' }, ['Payments']))).toBe(true)
    const lending = resolveSearchScope({ project: 'Lending' }, ['Payments'])
    expect(inSearchScope({ project: 'lending' }, lending)).toBe(true)
    expect(inSearchScope({ project: 'Payments' }, lending)).toBe(false)
    expect(inSearchScope({}, lending)).toBe(false)
  })

  it('narrows to an author, and never hides a tool that cannot carry a label', () => {
    const ana = resolveSearchScope({ author: 'Ana' }, ['Payments'])
    expect(inSearchScope({ project: 'Payments', author: 'ana' }, ana)).toBe(true)
    expect(inSearchScope({ project: 'Payments', author: 'bo' }, ana)).toBe(false)
    expect(inSearchScope({}, resolveSearchScope({ project: 'Lending', author: 'bo' }, []), false)).toBe(true)
  })
})

describe('search_docs', () => {
  const tool = (name: string, labels: { project?: string; author?: string } = {}): Tool =>
    ({ name, description: `uploads files ${name}`, group: 'read', parametersSchema: z.object({}), ...labels, execute: async () => ({ content: '' }) }) as Tool
  const skill = (name: string, labels: { project?: string; author?: string } = {}): Skill => ({
    name,
    description: 'how we upload files',
    filePath: `/s/${name}.md`,
    ...labels,
  })
  const options = {
    listTools: () => [tool('py__upload_pay', { project: 'Payments' }), tool('py__upload_lend', { project: 'Lending' }), tool('s3__upload')],
    listSkills: () => [skill('upload-pay', { project: 'Payments', author: 'ana' }), skill('upload-lend', { project: 'Lending', author: 'bo' }), skill('upload-old')],
    currentProject: () => ['Payments'],
  }
  const names = async (params: { project?: string; author?: string }): Promise<{ names: string[]; hidden: number }> => {
    const result = await runDocsSearch(options, { query: 'upload files', limit: 10, ...params })
    return { names: result.matches.map((match) => match.name).sort(), hidden: result.hidden }
  }

  it('finds this project\'s and unlabelled ones by default, and says how many it left out', async () => {
    expect(await names({})).toEqual({ names: ['py__upload_pay', 's3__upload', 'upload-old', 'upload-pay'], hidden: 2 })
  })

  it('goes beyond the project when asked', async () => {
    expect((await names({ project: 'all' })).names).toHaveLength(6)
  })

  it('searches another named project, keeping only tools that belong to no project', async () => {
    expect(await names({ project: 'Lending' })).toEqual({ names: ['py__upload_lend', 's3__upload', 'upload-lend'], hidden: 3 })
  })

  it('narrows to an author', async () => {
    expect((await names({ project: 'all', author: 'bo' })).names).toEqual(['s3__upload', 'upload-lend'])
  })
})

describe('search_team_skills', () => {
  it('asks the engine for this project, or no project, by default — and for one author when named', async () => {
    const asked: VectorSearchOptions[] = []
    const options = {
      searcher: { kind: 'opensearch', label: 'x', searchByVector: async (_c: string, _v: readonly number[], o: VectorSearchOptions) => (asked.push(o), []) },
      embedder: { embed: async () => [0.1] },
      collections: ['team-skills'],
    } as never
    await searchTeamSkills(options, 'deploy', 5, undefined, resolveSearchScope({}, ['Payments', 'pay-api']))
    await searchTeamSkills(options, 'deploy', 5, undefined, resolveSearchScope({ project: 'all', author: 'bo' }, ['Payments']))
    expect(asked[0]?.project).toEqual({ names: ['Payments', 'pay-api'], includeUnlabelled: true })
    expect(asked[0]?.owner).toBeUndefined()
    expect(asked[1]?.project).toBeUndefined()
    expect(asked[1]?.owner).toBe('bo')
  })
})

/** Records each request body, answering every call with an empty but valid response. */
function recorder(answer: (url: string, method: string) => unknown = () => ({})): { http: HttpClient; bodies: unknown[] } {
  const bodies: unknown[] = []
  const http: HttpClient = {
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      if (options.body !== undefined) bodies.push(JSON.parse(options.body))
      const payload = answer(url, options.method ?? 'GET')
      return { status: 200, headers: {}, text: async () => JSON.stringify(payload), json: async <T>() => payload as T, body: null }
    },
  }
  return { http, bodies }
}

describe('each backend filters by project in the engine', () => {
  const scoped: VectorSearchOptions = { size: 5, owner: 'bo', project: { names: ['Payments'], includeUnlabelled: true } }

  it('OpenSearch: this project or a missing field, inside the knn filter', async () => {
    const { http, bodies } = recorder(() => ({ hits: { hits: [] } }))
    await new OpenSearchClient(http, { url: 'https://os.test' } as never).searchByVector('team', [0.1], scoped)
    const filter = JSON.stringify(bodies[0])
    expect(filter).toContain('{"term":{"owner":"bo"}}')
    expect(filter).toContain('{"terms":{"project":["Payments"]}}')
    expect(filter).toContain('{"exists":{"field":"project"}}')
  })

  it('Qdrant: owner must match, and project matches or is empty', async () => {
    const { http, bodies } = recorder(() => ({ result: [] }))
    await new QdrantSearcher(http, { url: 'http://127.0.0.1:6333', label: 'q' }).searchByVector('team', [0.1], scoped)
    expect((bodies[0] as { filter: unknown }).filter).toEqual({
      must: [{ key: 'owner', match: { value: 'bo' } }],
      should: [{ key: 'project', match: { any: ['Payments'] } }, { is_empty: { key: 'project' } }],
    })
  })

  it('Chroma: an exact project list goes into `where`; "or unlabelled" is filtered after', async () => {
    const collection = { id: 'col-1', name: 'team', metadata: { created_by: 'light-code', dimensions: 1 } }
    const { http, bodies } = recorder((url, method) =>
      method === 'GET'
        ? collection
        : { ids: [['a', 'b', 'c']], distances: [[0, 0, 0]], documents: [['a', 'b', 'c']], metadatas: [[{ path: 'skill:a', project: 'Payments' }, { path: 'skill:b', project: 'Lending' }, { path: 'skill:c' }]] },
    )
    const searcher = new ChromaSearcher(http, { url: 'http://127.0.0.1:8000', label: 'c' })
    const matches = await searcher.searchByVector('team', [0.1], { size: 5, project: { names: ['Payments'], includeUnlabelled: true } })
    expect(matches.map((match) => match.path)).toEqual(['skill:a', 'skill:c'])

    await searcher.searchByVector('team', [0.1], { size: 5, owner: 'bo', project: { names: ['Lending'], includeUnlabelled: false } })
    expect((bodies.at(-1) as { where: unknown }).where).toEqual({ $and: [{ owner: 'bo' }, { project: { $in: ['Lending'] } }] })
  })
})

describe('the default scope chosen in Settings -> Project', () => {
  const current = ['Payments']

  it('"This project" is the default, and behaves as before', () => {
    expect(resolveSearchScope({}, current, { mode: 'project', author: 'ana' })).toEqual(resolveSearchScope({}, current))
  })

  it('"Only mine" keeps what this author wrote, in any project', () => {
    const mine = resolveSearchScope({}, current, { mode: 'author', author: 'ana' })
    expect(inSearchScope({ project: 'Lending', author: 'Ana' }, mine)).toBe(true)
    expect(inSearchScope({ project: 'Payments', author: 'bo' }, mine)).toBe(false)
    expect(inSearchScope({}, mine, false)).toBe(true)
  })

  it('"Everything" filters nothing', () => {
    expect(inSearchScope({ project: 'Lending', author: 'bo' }, resolveSearchScope({}, current, { mode: 'all' }))).toBe(true)
  })

  it('whatever the default, a request that names a project or an author wins', () => {
    const asked = resolveSearchScope({ project: 'Lending' }, current, { mode: 'all' })
    expect(inSearchScope({ project: 'Payments' }, asked)).toBe(false)
    const mineButAskedAll = resolveSearchScope({ project: 'all' }, current, { mode: 'author', author: 'ana' })
    expect(inSearchScope({ project: 'Lending', author: 'bo' }, mineButAskedAll)).toBe(true)
  })
})
