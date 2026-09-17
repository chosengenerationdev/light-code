import { describe, expect, it } from 'vitest'
import { fromMcpServerForm, toMcpServerForm } from './forms.js'
import { mcpServersSchema } from './types.js'

/**
 * Which protocol a remote MCP server is spoken to with.
 *
 * Reported from real use: an HTTP MCP server carrying Jira and Confluence tokens as headers,
 * working in another client and answering 401 here. `type` was not in the schema, and zod strips
 * what it does not declare — so a pasted config saying `"type": "sse"` parsed happily, lost that
 * word, and was then driven with Streamable HTTP. §11 requires a pasted config to work unchanged,
 * and this is the field that decides whether it works at all.
 */
describe('a remote server declares its protocol', () => {
  const parse = (entry: unknown): Record<string, unknown> => {
    const result = mcpServersSchema.safeParse({ atlassian: entry })
    expect(result.success).toBe(true)
    return (result.success ? result.data.atlassian : {}) as Record<string, unknown>
  }

  it('keeps `type` from a config pasted out of another client', () => {
    const entry = parse({
      type: 'sse',
      url: 'https://mcp.example/sse',
      headers: { 'X-Token': 'abc' },
    })
    expect(entry['type']).toBe('sse')
  })

  it('keeps the headers beside it', () => {
    expect(parse({ type: 'sse', url: 'https://mcp.example/sse', headers: { 'X-Token': 'abc' } })['headers']).toEqual({
      'X-Token': 'abc',
    })
  })

  it('accepts streamable-http, and http as a spelling of it', () => {
    expect(parse({ type: 'streamable-http', url: 'https://mcp.example/mcp' })['type']).toBe('streamable-http')
    expect(parse({ type: 'http', url: 'https://mcp.example/mcp' })['type']).toBe('http')
  })

  /* Absent is still valid — every existing configuration was written without it. */
  it('does not require it', () => {
    expect(parse({ url: 'https://mcp.example/mcp' })['url']).toBe('https://mcp.example/mcp')
  })

  it('refuses a protocol nobody implements, rather than ignoring the word', () => {
    expect(mcpServersSchema.safeParse({ a: { type: 'websocket', url: 'https://x.example/' } }).success).toBe(false)
  })
})

/**
 * An edit in the MCP tab is about one field, and must not quietly undo another. The form has no
 * control for `type`, so without this a save about a timeout would turn a declared SSE server
 * back into a guess.
 */
describe('editing a server in the tab', () => {
  const existing = { type: 'sse' as const, url: 'https://mcp.example/sse', headers: { 'X-Token': 'abc' } }

  it('keeps the declared protocol across a save', () => {
    const saved = fromMcpServerForm(toMcpServerForm(existing), 'win32', existing)
    expect(saved).toMatchObject({ type: 'sse', url: 'https://mcp.example/sse' })
  })

  it('keeps the headers across a save', () => {
    const saved = fromMcpServerForm(toMcpServerForm(existing), 'win32', existing)
    expect(saved).toMatchObject({ headers: { 'X-Token': 'abc' } })
  })

  it('adds nothing to a server that never declared one', () => {
    const plain = { url: 'https://mcp.example/mcp' }
    expect(fromMcpServerForm(toMcpServerForm(plain), 'win32', plain)).not.toHaveProperty('type')
  })
})
