import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Embedder } from '../rag/embedder.js'
import { buildDocCorpus, docEntryId, parseDocEntryId, toolDocText } from '../rag/toolDocs.js'
import type { VectorMatch, VectorSearcher } from '../rag/vectorStore.js'
import type { Skill } from '../skills/index.js'
import { createSearchDocsTool, renderDocsMatches, runDocsSearch } from './searchDocs.js'
import type { Tool, ToolExecutionContext } from './types.js'

const noContext = {} as unknown as ToolExecutionContext
const embedder = { embed: async () => [0.1, 0.2, 0.3] } as unknown as Embedder

function tool(name: string, description: string, group: Tool['group'] = 'read'): Tool {
  return {
    name,
    group,
    description,
    parametersSchema: z.object({ key: z.string().describe('the object key') }),
  execute: async () => ({ content: 'ran' }),
  }
}

function skill(name: string, description: string): Skill {
  return { name, description, filePath: `/ws/.lightcode/skills/${name}.md` }
}

function searcherReturning(paths: string[]): VectorSearcher {
  return {
    kind: 'opensearch',
    label: 'corp cluster',
    searchByVector: async (): Promise<VectorMatch[]> =>
      paths.map((path, index) => ({ id: path, score: 1 - index * 0.1, text: '', path })),
  }
}

describe('doc entry ids', () => {
  it('round-trips, and keeps a tool and a skill of the same name apart', () => {
    expect(parseDocEntryId(docEntryId('tool', 'deploy'))).toEqual({ kind: 'tool', name: 'deploy' })
    expect(parseDocEntryId(docEntryId('skill', 'deploy'))).toEqual({ kind: 'skill', name: 'deploy' })
  })

  it('rejects anything that is not one of ours', () => {
    expect(parseDocEntryId('src/app.ts')).toBeUndefined()
    expect(parseDocEntryId('other:thing')).toBeUndefined()
    expect(parseDocEntryId('tool:')).toBeUndefined()
  })

  /** A tool name resolved from a *codebase* index hit must not be treated as a doc entry. */
  it('does not mistake a colon in a file path for a kind', () => {
    expect(parseDocEntryId('C:/repo/file.ts')).toBeUndefined()
  })
})

describe('the doc corpus', () => {
  it('indexes only hidden tools, since a listed one needs no retrieval', () => {
    const entries = buildDocCorpus({ dispatchOnlyTools: [tool('s3__get_object', 'fetch an object')] })
    expect(entries.map((entry) => entry.id)).toEqual(['tool:s3__get_object'])
  })

  it('includes skills alongside tools, sorted for a stable re-index', () => {
    const entries = buildDocCorpus({
      dispatchOnlyTools: [tool('z__last', 'z'), tool('a__first', 'a')],
      skills: [skill('deployment', 'how we deploy')],
    })
    expect(entries.map((entry) => entry.id)).toEqual(['skill:deployment', 'tool:a__first', 'tool:z__last'])
  })

  /**
   * A prose query has to reach an underscored, namespaced identifier. Embedding the raw name
   * alone matches poorly, so the split form is part of the indexed text.
   */
  it('embeds a de-namespaced form of the tool name', () => {
    const text = toolDocText(tool('confluence__create_page', 'make a page'))
    expect(text).toContain('confluence create page')
    expect(text).toContain('"key"') // the schema is in the indexed text too
  })
})

describe('search_docs', () => {
  const tools = [
    tool('s3__get_object', 'Download an object from bucket storage'),
    tool('confluence__create_page', 'Publish a page to the team wiki'),
  ]
  const options = { listTools: () => tools, listSkills: () => [skill('deployment', 'How we ship to production')] }

  it('returns the live schema and tells the model how to invoke it', async () => {
    const result = await createSearchDocsTool({
      ...options,
      retrieval: { searcher: searcherReturning(['tool:s3__get_object']), embedder, index: 'lc-docs' },
    }).execute({ query: 'download a file' }, noContext)

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('tool: s3__get_object')
    expect(result.content).toContain('"key"')
    expect(result.content).toContain('call_tool({"name": "s3__get_object"')
  })

  /**
   * The index finds things; it never supplies the schema. A server that restarted with a
   * changed signature would otherwise feed the model arguments that no longer validate.
   */
  it('renders from the registry even when the index is stale', async () => {
    const renamed = [tool('s3__get_object', 'A DESCRIPTION THAT CHANGED SINCE INDEXING')]
    const result = await createSearchDocsTool({
      listTools: () => renamed,
      retrieval: { searcher: searcherReturning(['tool:s3__get_object']), embedder, index: 'lc-docs' },
    }).execute({ query: 'download' }, noContext)

    expect(result.content).toContain('A DESCRIPTION THAT CHANGED SINCE INDEXING')
  })

  /** An index entry for a tool whose server is gone must not be offered and then fail. */
  it('drops a hit for a tool that no longer exists', async () => {
    const { matches } = await runDocsSearch(
      {
        listTools: () => tools,
        retrieval: { searcher: searcherReturning(['tool:deleted__tool', 'tool:s3__get_object']), embedder, index: 'lc-docs' },
      },
      { query: 'anything' },
    )
    expect(matches).toEqual([{ kind: 'tool', name: 's3__get_object' }])
  })

  it('honours the kind filter', async () => {
    const { matches } = await runDocsSearch(
      {
        ...options,
        retrieval: { searcher: searcherReturning(['tool:s3__get_object', 'skill:deployment']), embedder, index: 'lc-docs' },
      },
      { query: 'anything', kind: 'skill' },
    )
    expect(matches).toEqual([{ kind: 'skill', name: 'deployment' }])
  })

  it('points a skill hit at read_file rather than inlining the body', async () => {
    const result = await createSearchDocsTool({
      ...options,
      retrieval: { searcher: searcherReturning(['skill:deployment']), embedder, index: 'lc-docs' },
    }).execute({ query: 'how do we ship' }, noContext)

    expect(result.content).toContain('skill: deployment')
    expect(result.content).toContain('read_file: /ws/.lightcode/skills/deployment.md')
  })
})

describe('search_docs without a working index', () => {
  const tools = [
    tool('s3__get_object', 'Download an object from bucket storage'),
    tool('confluence__create_page', 'Publish a page to the team wiki'),
  ]
  const options = { listTools: () => tools }

  /**
   * Not a nicety. Without this, turning the dispatcher on before configuring a vector store
   * would make every hidden tool permanently unreachable, and it would look like the tools
   * had vanished rather than like a missing setting.
   */
  it('still finds tools lexically when no vector store is configured', async () => {
    const { matches, via } = await runDocsSearch(options, { query: 'publish a wiki page' })
    expect(via).toBe('lexical')
    expect(matches).toEqual([{ kind: 'tool', name: 'confluence__create_page' }])
  })

  it('falls back, and says so, when the index errors', async () => {
    const result = await createSearchDocsTool({
      ...options,
      retrieval: {
        searcher: {
          kind: 'opensearch',
          label: 'corp cluster',
          searchByVector: async () => {
            throw new Error('cluster unreachable')
          },
        },
        embedder,
        index: 'lc-docs',
      },
    }).execute({ query: 'download an object' }, noContext)

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('cluster unreachable')
    expect(result.content).toContain('s3__get_object')
  })

  /** An empty index and an unmatched query are indistinguishable, so try the cheap path too. */
  it('falls back when the index returns nothing', async () => {
    const { matches, via } = await runDocsSearch(
      { ...options, retrieval: { searcher: searcherReturning([]), embedder, index: 'lc-docs' } },
      { query: 'bucket storage' },
    )
    expect(via).toBe('lexical')
    expect(matches).toEqual([{ kind: 'tool', name: 's3__get_object' }])
  })

  it('says the match was lexical, so a silently unused index is visible', async () => {
    const result = await createSearchDocsTool(options).execute({ query: 'bucket storage' }, noContext)
    expect(result.content).toContain('not by meaning')
  })

  it('returns a usable message when nothing matches at all', async () => {
    const result = await createSearchDocsTool(options).execute({ query: 'zzzz' }, noContext)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('Nothing matched')
  })
})

/**
 * A scheduled run can find a tool it was never granted. Discovering that by calling it and
 * being refused costs a step and produces a report that reads like a failure — where the
 * useful answer is "this needed X, which this schedule may not use".
 */
describe('search results in a run with restricted tools', () => {
  const restricted = tool('deploy_service', 'Deploys a service')

  it('says plainly that a found tool cannot be called here', async () => {
    const rendered = renderDocsMatches(
      { listTools: () => [restricted], accessibleTo: () => false },
      [{ kind: 'tool', name: 'deploy_service' }],
    )
    expect(rendered).toContain('NOT AVAILABLE')
    expect(rendered).not.toContain('Call it with')
  })

  it('gives the normal call instruction when it is available', async () => {
    const rendered = renderDocsMatches(
      { listTools: () => [restricted], accessibleTo: () => true },
      [{ kind: 'tool', name: 'deploy_service' }],
    )
    expect(rendered).toContain('Call it with')
    expect(rendered).not.toContain('NOT AVAILABLE')
  })

  /** The chat passes no predicate, and must not start warning about tools it can call. */
  it('treats everything as callable when nothing says otherwise', () => {
    const rendered = renderDocsMatches({ listTools: () => [restricted] }, [
      { kind: 'tool', name: 'deploy_service' },
    ])
    expect(rendered).toContain('Call it with')
  })

  /** Annotated, never hidden: a run that cannot see it cannot explain what it would have needed. */
  it('still returns the tool rather than dropping it', () => {
    const rendered = renderDocsMatches(
      { listTools: () => [restricted], accessibleTo: () => false },
      [{ kind: 'tool', name: 'deploy_service' }],
    )
    expect(rendered).toContain('deploy_service')
  })
})
