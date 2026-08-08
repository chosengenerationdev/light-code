import { describe, expect, it } from 'vitest'
import { parseConfig } from '../config/schema.js'
import {
  isPackageRunnerCommand,
  isStdioServer,
  mcpServersSchema,
  namespacedToolName,
  parseNamespacedToolName,
} from './types.js'

describe('namespacing', () => {
  it('round-trips a namespaced name', () => {
    const name = namespacedToolName('filesystem', 'read_file')
    expect(name).toBe('filesystem__read_file')
    expect(parseNamespacedToolName(name)).toEqual({ serverName: 'filesystem', toolName: 'read_file' })
  })

  it('lets two servers expose the same tool name without colliding', () => {
    const a = namespacedToolName('serverA', 'read_file')
    const b = namespacedToolName('serverB', 'read_file')
    expect(a).not.toBe(b)
  })

  it('keeps underscores inside a tool name intact', () => {
    const name = namespacedToolName('git', 'get_file_contents')
    expect(parseNamespacedToolName(name)).toEqual({ serverName: 'git', toolName: 'get_file_contents' })
  })

  it('rejects a name with no namespace separator', () => {
    expect(parseNamespacedToolName('read_file')).toBeUndefined()
  })
})

describe('package runner detection', () => {
  it.each(['npx', 'npx.cmd', 'pnpm', 'bunx', 'uvx', 'C:\\Program Files\\nodejs\\npx.cmd', '/usr/bin/npx'])(
    'flags %s',
    (command) => {
      expect(isPackageRunnerCommand(command)).toBe(true)
    },
  )

  it.each(['node', 'python', './my-server', 'C:\\tools\\server.exe'])('does not flag %s', (command) => {
    expect(isPackageRunnerCommand(command)).toBe(false)
  })
})

describe('config shape', () => {
  it('accepts a config pasted from another MCP client unmodified', () => {
    // Verbatim from the shape other clients document — no `type` field, no extra nesting.
    const pasted = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
        remote: {
          url: 'https://mcp.example.com/mcp',
        },
      },
    }

    const parsed = parseConfig(JSON.stringify(pasted))
    expect(Object.keys(parsed.mcpServers ?? {})).toEqual(['filesystem', 'remote'])

    const filesystem = parsed.mcpServers?.filesystem
    expect(filesystem !== undefined && isStdioServer(filesystem)).toBe(true)
    const remote = parsed.mcpServers?.remote
    expect(remote !== undefined && isStdioServer(remote)).toBe(false)
  })

  it('rejects a server entry that is neither stdio nor http', () => {
    expect(mcpServersSchema.safeParse({ broken: { foo: 'bar' } }).success).toBe(false)
  })

  it('rejects a malformed url', () => {
    expect(mcpServersSchema.safeParse({ remote: { url: 'not-a-url' } }).success).toBe(false)
  })
})
