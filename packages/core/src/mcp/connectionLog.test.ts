import { describe, expect, it } from 'vitest'
import { describeMcpRequest } from './client.js'
import type { SecretStore } from '../platform/secrets.js'

/**
 * What the server's log says before a connection is attempted.
 *
 * Written for a report this could not otherwise answer: a remote MCP server replying "double check
 * your token or domain" while the configuration plainly held a token. Four different fixes hide
 * behind that one message — the header was never sent, sent empty, sent under a name the server
 * does not read, or sent over the wrong protocol — and nothing distinguished them from outside.
 *
 * **Names only, never values.** The line exists to be pasted into a bug report.
 */

const secrets = (values: Record<string, string>): SecretStore =>
  ({
    get: async (key: string) => values[key],
    set: async () => {},
    delete: async () => {},
    backend: 'memory',
  }) as unknown as SecretStore

const lineFor = (config: Record<string, unknown>, stored: Record<string, string> = {}): Promise<string> =>
  describeMcpRequest(config as never, secrets(stored))

describe('the line logged before connecting', () => {
  it('names the header it is sending', async () => {
    const line = await lineFor({
      url: 'https://mcp.example/mcp',
      headers: { 'X-Jira-Token': 'secret-value' },
    })
    expect(line).toContain('X-Jira-Token')
  })

  /* The whole reason this is safe to paste anywhere. */
  it('never shows the value', async () => {
    const line = await lineFor({
      url: 'https://mcp.example/mcp',
      headers: { 'X-Jira-Token': 'secret-value' },
    })
    expect(line).not.toContain('secret-value')
  })

  it('says which protocol it is using, and that SSE is the fallback when none is set', async () => {
    expect(await lineFor({ url: 'https://mcp.example/mcp' })).toContain('SSE is the fallback')
    expect(await lineFor({ url: 'https://mcp.example/sse', type: 'sse' })).toContain('as sse')
  })

  /* An empty token reads as a rejected one at the server, and looks identical in the config. */
  it('marks a header whose value resolved to nothing', async () => {
    const line = await lineFor(
      { url: 'https://mcp.example/mcp', headers: { 'X-Token': '${secret:TOKEN}' } },
      { TOKEN: '   ' },
    )
    expect(line).toContain('X-Token (EMPTY)')
  })

  it('says so when no headers are configured at all', async () => {
    expect(await lineFor({ url: 'https://mcp.example/mcp' })).toContain('no headers configured')
  })

  it('reports a secret that is referenced but not stored, rather than staying silent', async () => {
    const line = await lineFor({ url: 'https://mcp.example/mcp', headers: { 'X-Token': '${secret:MISSING}' } })
    expect(line).toContain('headers unresolved')
    expect(line).toContain('MISSING')
  })
})
