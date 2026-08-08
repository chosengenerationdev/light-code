import { describe, expect, it } from 'vitest'
import { createDefaultToolRegistry } from '../tools/index.js'
import { toToolDefinitions } from '../tools/registry.js'
import { ASK_MODE, CODE_MODE, findMode } from './builtin.js'
import { toolsForMode } from './resolve.js'

describe('toolsForMode', () => {
  const registry = createDefaultToolRegistry()

  it('Code mode exposes every tool', () => {
    const names = toolsForMode(registry, CODE_MODE).map((tool) => tool.name)
    expect(names).toContain('read_file')
    expect(names).toContain('apply_diff')
    expect(names).toContain('execute_command')
  })

  it('Ask mode removes edit and command tools entirely', () => {
    const names = toolsForMode(registry, ASK_MODE).map((tool) => tool.name)

    expect(names).toContain('read_file')
    expect(names).toContain('search_files')
    expect(names).toContain('attempt_completion')

    // The acceptance criterion: not merely blocked at execution — absent.
    expect(names).not.toContain('write_to_file')
    expect(names).not.toContain('apply_diff')
    expect(names).not.toContain('execute_command')
  })

  it('excluded tools do not reach the system prompt definitions', () => {
    const definitions = toToolDefinitions(toolsForMode(registry, ASK_MODE))
    const serialized = JSON.stringify(definitions)

    // The model is never told these exist, so it cannot call what it does not know about.
    expect(serialized).not.toContain('apply_diff')
    expect(serialized).not.toContain('execute_command')
  })
})

describe('findMode', () => {
  it('resolves known ids', () => {
    expect(findMode('ask').id).toBe('ask')
    expect(findMode('code').id).toBe('code')
  })

  it('falls back to Code for unknown or missing ids', () => {
    expect(findMode(undefined).id).toBe('code')
    expect(findMode('nonsense').id).toBe('code')
  })
})
