import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { takeWhy, toToolDefinitions, ToolRegistry } from './registry.js'
import type { Tool } from './types.js'

/**
 * Reported as "I just see the tool name being called" — the transcript was a list of verbs with
 * no account of what any of them was for. Most models emit no assistant text alongside a tool
 * call, so asking them to explain in prose beforehand fails in exactly the cases that matter.
 * Making the reason part of the call means it is always available.
 */
const tool = (name: string, schema: z.ZodType, raw?: unknown): Tool =>
  ({
    name,
    group: 'read',
    description: name,
    parametersSchema: schema,
    ...(raw === undefined ? {} : { rawJsonSchema: raw }),
    execute: async () => ({ content: '' }),
  }) as Tool

const definitionFor = (entry: Tool): { properties?: Record<string, unknown>; required?: string[] } => {
  const registry = new ToolRegistry()
  registry.register(entry)
  return toToolDefinitions(registry.list())[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] }
}

describe('the why parameter', () => {
  it('is offered on an ordinary tool', () => {
    const parameters = definitionFor(tool('read_file', z.object({ path: z.string() })))
    expect(Object.keys(parameters.properties ?? {})).toEqual(expect.arrayContaining(['path', 'why']))
  })

  /** Optional always: a model that ignores it must still be able to call the tool. */
  it('is never required', () => {
    const parameters = definitionFor(tool('read_file', z.object({ path: z.string() })))
    expect(parameters.required ?? []).not.toContain('why')
  })

  it('is offered on a tool with no parameters of its own', () => {
    const parameters = definitionFor(tool('list_sessions', z.object({})))
    expect(Object.keys(parameters.properties ?? {})).toEqual(['why'])
  })

  /**
   * An MCP server sends its own schema and section 11 forbids translating it. Adding a property
   * is safe only because the value is stripped before the server sees it — but a schema shaped
   * in a way this does not anticipate is left completely alone rather than guessed at.
   */
  it('is added to an MCP schema without disturbing the rest of it', () => {
    const parameters = definitionFor(
      tool('s3__get', z.object({}), {
        type: 'object',
        properties: { bucket: { type: 'string' } },
        required: ['bucket'],
        additionalProperties: false,
      }),
    )
    expect(Object.keys(parameters.properties ?? {})).toEqual(['bucket', 'why'])
    expect(parameters.required).toEqual(['bucket'])
  })

  it('leaves a schema it does not understand exactly as it was', () => {
    const weird = { anyOf: [{ type: 'string' }, { type: 'number' }] }
    expect(definitionFor(tool('odd', z.object({}), weird))).toEqual(weird)
  })

  it('does not overwrite a tool that already has a why of its own', () => {
    const own = { type: 'object', properties: { why: { type: 'number' } } }
    const parameters = definitionFor(tool('own', z.object({}), own))
    expect((parameters.properties ?? {}).why).toEqual({ type: 'number' })
  })
})

describe('taking the reason off a call', () => {
  it('separates it from what the tool receives', () => {
    expect(takeWhy({ path: 'a.ts', why: 'checking the export list' })).toEqual({
      why: 'checking the export list',
      rest: { path: 'a.ts' },
    })
  })

  /** A strict schema would reject it, and an MCP server never declared it. */
  it('always removes it, even when it is empty or the wrong type', () => {
    expect(takeWhy({ path: 'a.ts', why: '   ' })).toEqual({ rest: { path: 'a.ts' } })
    expect(takeWhy({ path: 'a.ts', why: 42 })).toEqual({ rest: { path: 'a.ts' } })
  })

  it('leaves a call without one untouched', () => {
    expect(takeWhy({ path: 'a.ts' })).toEqual({ rest: { path: 'a.ts' } })
  })
})
