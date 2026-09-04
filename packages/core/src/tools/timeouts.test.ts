import { describe, expect, it } from 'vitest'

import { timeoutForTool, timeoutTargetFor } from './timeouts.js'
import type { McpServersConfig } from '../mcp/types.js'

/**
 * A limit exists to notice a call that will never finish, so the closer a setting sits to the
 * particular tool, the more it should be believed: someone saying "this one report takes ten
 * minutes" knows something a machine-wide setting cannot. The global one is for the opposite
 * case — "everything here is slow" is a property of the environment, not of any tool.
 */
const servers: McpServersConfig = {
  reports: { command: 'srv', timeout: 120, toolTimeouts: { generate: 600 } },
  quick: { command: 'srv' },
}

describe('resolving a tool’s timeout', () => {
  it('prefers the tool’s own limit over everything else', () => {
    expect(timeoutForTool('read_file', { perTool: { read_file: 45 }, global: 90, mcpServers: servers })).toBe(45)
    // Even over the server's, for a tool that has both.
    expect(timeoutForTool('reports__generate', { perTool: { 'reports__generate': 30 }, mcpServers: servers })).toBe(30)
  })

  it('falls back to the server’s per-tool limit, then the server’s own', () => {
    expect(timeoutForTool('reports__generate', { global: 90, mcpServers: servers })).toBe(600)
    expect(timeoutForTool('reports__list', { global: 90, mcpServers: servers })).toBe(120)
  })

  it('falls back to the global limit when nothing nearer applies', () => {
    expect(timeoutForTool('quick__ping', { global: 90, mcpServers: servers })).toBe(90)
    expect(timeoutForTool('read_file', { global: 90 })).toBe(90)
  })

  /**
   * Undefined is meaningful and not the same as a large number: it means each kind of tool keeps
   * its own default, which is the state almost everything is in.
   */
  it('returns nothing when no limit has been set anywhere', () => {
    expect(timeoutForTool('read_file', {})).toBeUndefined()
    expect(timeoutForTool('quick__ping', { mcpServers: servers })).toBeUndefined()
  })

  /** A built-in tool whose name happens to contain `__` must not be read as an MCP tool. */
  it('is not confused by a double underscore in a name that is not namespaced', () => {
    expect(timeoutForTool('py__helper', { global: 90, mcpServers: servers })).toBe(90)
  })
})

describe('where a timeout is written', () => {
  /**
   * An MCP tool's limit belongs inside its server's entry: that is where a config pasted from
   * another client puts it, and where it survives being exported and pasted again.
   */
  it('sends an MCP tool’s limit to its server’s own store', () => {
    expect(timeoutTargetFor('reports__generate', servers)).toEqual({ kind: 'mcp', server: 'reports', tool: 'generate' })
  })

  it('sends everything else to the universal store', () => {
    expect(timeoutTargetFor('read_file', servers)).toEqual({ kind: 'tools', name: 'read_file' })
    expect(timeoutTargetFor('excel_read_range', servers)).toEqual({ kind: 'tools', name: 'excel_read_range' })
  })

  /** A namespaced name whose server is gone has nowhere server-shaped to go. */
  it('sends a tool from an unknown server to the universal store', () => {
    expect(timeoutTargetFor('vanished__thing', servers)).toEqual({ kind: 'tools', name: 'vanished__thing' })
  })
})
