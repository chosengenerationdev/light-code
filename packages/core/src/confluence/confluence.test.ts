import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { USER_SCOPE_ONLY_KEYS } from '../config/scopes.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { ConfluenceClient, describeFailure } from './client.js'
import { createConfluenceReadPageTool, createConfluenceWritePageTool } from './tools.js'

interface Recorded {
  url: string
  options: HttpRequestOptions
}

/** A Confluence that answers from a table keyed by "METHOD path-without-query". */
function fakeConfluence(routes: Record<string, { status?: number; json?: unknown; bytes?: Uint8Array }>) {
  const calls: Recorded[] = []
  const http: HttpClient = {
    async request(url, options = {}) {
      calls.push({ url, options })
      const path = new URL(url).pathname.replace(/^\/wiki/, '')
      const route = routes[`${options.method ?? 'GET'} ${path}`] ?? { status: 404, json: { message: 'no route' } }
      const bytes = route.bytes ?? new TextEncoder().encode(JSON.stringify(route.json ?? {}))
      const response: HttpResponse = {
        status: route.status ?? 200,
        headers: {},
        text: async () => new TextDecoder().decode(bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
      }
      return response
    },
  }
  const client = new ConfluenceClient(http, { baseUrl: 'https://wiki.test/wiki/', token: 'pat-123' })
  return { client, calls }
}

const PAGE = {
  id: '42',
  title: 'Onboarding',
  space: { key: 'TEAM' },
  version: { number: 3 },
  body: { storage: { value: '<p>old</p>' } },
  ancestors: [{ title: 'Home' }],
  _links: { webui: '/display/TEAM/Onboarding' },
}

const NO_CONTEXT = {} as unknown as ToolExecutionContext

describe('the Confluence client', () => {
  it('sends the personal access token as a Bearer token, under the site context path', async () => {
    const { client, calls } = fakeConfluence({ 'GET /rest/api/user/current': { json: { displayName: 'Dana' } } })
    expect(await client.currentUser()).toBe('Dana')
    expect(calls[0]?.url).toBe('https://wiki.test/wiki/rest/api/user/current')
    expect(calls[0]?.options.headers?.['Authorization']).toBe('Bearer pat-123')
  })

  it('replaces an attachment by name with a multipart PUT Confluence accepts', async () => {
    const { client, calls } = fakeConfluence({ 'PUT /rest/api/content/42/child/attachment': { json: {} } })
    await client.attach('42', { name: 'diagram.png', bytes: new Uint8Array([1, 2, 3]) })
    const call = calls[0]
    expect(call?.options.method).toBe('PUT')
    expect(call?.options.headers?.['X-Atlassian-Token']).toBe('no-check')
    expect(call?.options.headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=/)
    // Bytes, not a string: a PNG through a string is corrupted without anything reporting it.
    expect(call?.options.bodyBytes).toBeInstanceOf(Uint8Array)
  })

  it('refuses an attachment name that could reach a header', async () => {
    const { client } = fakeConfluence({})
    await expect(client.attach('42', { name: 'a"\r\nX: y.png', bytes: new Uint8Array() })).rejects.toThrow(/cannot be used/)
  })

  /** A download link pointing anywhere else would carry the token with it. */
  it('never downloads from anywhere but its own site', async () => {
    const { client, calls } = fakeConfluence({})
    await expect(client.download('https://elsewhere.test/steal')).rejects.toThrow(/not a link on/)
    expect(calls).toHaveLength(0)
  })

  it('says what to do about the failures people actually hit', () => {
    expect(describeFailure('reading', 401, '')).toMatch(/Settings → Tools → Confluence/)
    expect(describeFailure('updating', 409, '')).toMatch(/Read it again/)
    expect(describeFailure('creating', 400, JSON.stringify({ message: 'Error parsing xhtml' }))).toMatch(
      /Error parsing xhtml[\s\S]*storage format/,
    )
  })
})

describe('reading a page', () => {
  it('lists the attachments, so an image can be replaced by name', async () => {
    const { client } = fakeConfluence({
      'GET /rest/api/content/42': { json: PAGE },
      'GET /rest/api/content/42/child/attachment': {
        json: { results: [{ title: 'arch.png', metadata: { mediaType: 'image/png' }, extensions: { fileSize: 10 } }] },
      },
    })
    const tool = createConfluenceReadPageTool({ client: async () => client })
    const result = await tool.execute({ pageId: '42' }, NO_CONTEXT)
    expect(result.content).toContain('arch.png')
    expect(result.content).toContain('<p>old</p>')
    expect(result.images).toBeUndefined()
  })

  it('returns the images for the model to look at when asked, and SVG as its source', async () => {
    const { client } = fakeConfluence({
      'GET /rest/api/content/42': { json: PAGE },
      'GET /rest/api/content/42/child/attachment': {
        json: {
          results: [
            { title: 'arch.png', metadata: { mediaType: 'image/png' }, extensions: { fileSize: 3 }, _links: { download: '/download/attachments/42/arch.png' } },
            { title: 'flow.svg', metadata: { mediaType: 'image/svg+xml' }, extensions: { fileSize: 20 }, _links: { download: '/download/attachments/42/flow.svg' } },
          ],
        },
      },
      'GET /download/attachments/42/arch.png': { bytes: new Uint8Array([137, 80, 78]) },
      'GET /download/attachments/42/flow.svg': { bytes: new TextEncoder().encode('<svg><text>API</text></svg>') },
    })
    const tool = createConfluenceReadPageTool({ client: async () => client })
    const result = await tool.execute({ pageId: '42', images: true }, NO_CONTEXT)
    expect(result.images?.map((image) => image.label)).toEqual(['arch.png'])
    expect(result.images?.[0]?.mediaType).toBe('image/png')
    expect(result.content).toContain('<svg><text>API</text></svg>')
  })
})

describe('writing a page', () => {
  it('previews an update as a diff against the live page, not the model’s description', async () => {
    const { client } = fakeConfluence({
      'GET /rest/api/content/42': { json: PAGE },
      'GET /rest/api/content/42/child/attachment': { json: { results: [] } },
    })
    const tool = createConfluenceWritePageTool({ client: async () => client })
    const preview = await tool.preview?.({ pageId: '42', body: '<p>new</p>' }, NO_CONTEXT)
    expect(preview).toMatchObject({ kind: 'diff', before: '<p>old</p>', after: '<p>new</p>' })
  })

  it('replaces an image without rewriting the page, and says it replaces one', async () => {
    const { client, calls } = fakeConfluence({
      'GET /rest/api/content/42': { json: PAGE },
      'GET /rest/api/content/42/child/attachment': {
        json: { results: [{ title: 'arch.svg', metadata: { mediaType: 'image/svg+xml' } }] },
      },
      'PUT /rest/api/content/42/child/attachment': { json: {} },
    })
    const tool = createConfluenceWritePageTool({ client: async () => client })
    const diagram = { name: 'arch.svg', diagram: { nodes: [{ id: 'a', label: 'API' }], edges: [] } }

    const preview = await tool.preview?.({ pageId: '42', diagrams: [diagram] } as never, NO_CONTEXT)
    expect(preview?.kind).toBe('text')
    expect(JSON.stringify(preview)).toContain('REPLACES')

    const result = await tool.execute({ pageId: '42', diagrams: [diagram] } as never, NO_CONTEXT)
    expect(result.isError).toBeUndefined()
    // No new version of the text: only the attachment went up.
    expect(calls.some((call) => call.options.method === 'PUT' && call.url.endsWith('/rest/api/content/42'))).toBe(false)
    expect(calls.some((call) => call.url.endsWith('/child/attachment') && call.options.method === 'PUT')).toBe(true)
  })

  /** Otherwise the model asks the user for a space they already chose in Settings. */
  it('tells the model which space new pages go to', () => {
    const { client } = fakeConfluence({})
    expect(createConfluenceWritePageTool({ client: async () => client, defaultSpace: 'TEAM' }).description).toContain(
      'New pages go to space TEAM',
    )
    expect(createConfluenceWritePageTool({ client: async () => client }).description).toContain('No default space')
  })

  it('refuses a new page with no body', async () => {
    const { client } = fakeConfluence({})
    const tool = createConfluenceWritePageTool({ client: async () => client, defaultSpace: 'TEAM' })
    const result = await tool.execute({ title: 'x' }, NO_CONTEXT)
    expect(result.isError).toBe(true)
  })
})

describe('the rules around it', () => {
  it('always asks before publishing', () => {
    expect(ALWAYS_ASK_TOOLS.has('confluence_write_page')).toBe(true)
  })

  /** A repository able to set it would choose where every page goes, and what is read as fact. */
  it('cannot be set by a workspace', () => {
    expect(USER_SCOPE_ONLY_KEYS).toContain('confluence')
  })
})
