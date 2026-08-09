import { describe, expect, it } from 'vitest'
import { normalizeObjectSchema, toAnthropicTools, toGeminiTools, toOpenAITools } from './schema.js'
import type { ToolDefinition } from './types.js'

const readFile: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path' },
      offset: { type: 'number', minimum: 0 },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

describe('normalizeObjectSchema', () => {
  /** A gateway that rejects this reports a bad request, not a bad schema — hard to trace. */
  it('gives a no-argument tool an explicit empty object schema', () => {
    expect(normalizeObjectSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(normalizeObjectSchema({})).toEqual({ type: 'object', properties: {} })
  })

  it('leaves a complete schema alone', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(normalizeObjectSchema(schema)).toEqual(schema)
  })

  it('does not invent properties on a non-object schema', () => {
    expect(normalizeObjectSchema({ type: 'string' })).toEqual({ type: 'string' })
  })
})

describe('toOpenAITools', () => {
  it('nests the schema under function.parameters', () => {
    const [tool] = toOpenAITools([readFile]) as [{ type: string; function: Record<string, unknown> }]
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('read_file')
    expect(tool.function.parameters).toMatchObject({ type: 'object', required: ['path'] })
  })

  it('keeps constraints OpenAI understands', () => {
    const [tool] = toOpenAITools([readFile]) as [{ function: { parameters: Record<string, unknown> } }]
    expect(tool.function.parameters.additionalProperties).toBe(false)
  })
})

describe('toAnthropicTools', () => {
  it('uses input_schema, not parameters', () => {
    const [tool] = toAnthropicTools([readFile]) as [Record<string, unknown>]
    expect(tool.input_schema).toMatchObject({ type: 'object' })
    expect(tool.parameters).toBeUndefined()
    expect(tool.name).toBe('read_file')
  })
})

describe('toGeminiTools', () => {
  it('wraps everything in a single functionDeclarations entry', () => {
    const tools = toGeminiTools([readFile, { name: 'x', description: 'y', parameters: {} }])
    expect(tools).toHaveLength(1)
    expect((tools[0] as { functionDeclarations: unknown[] }).functionDeclarations).toHaveLength(2)
  })

  /** Gemini 400s on these rather than ignoring them, so they must be gone entirely. */
  it('strips keywords Gemini rejects', () => {
    const [wrapper] = toGeminiTools([readFile]) as [{ functionDeclarations: { parameters: Record<string, unknown> }[] }]
    const parameters = wrapper.functionDeclarations[0]?.parameters as Record<string, unknown>

    expect(parameters.additionalProperties).toBeUndefined()
    expect(JSON.stringify(parameters)).not.toContain('minimum')
  })

  it('keeps the structure that actually describes the arguments', () => {
    const [wrapper] = toGeminiTools([readFile]) as [{ functionDeclarations: { parameters: Record<string, unknown> }[] }]
    const parameters = wrapper.functionDeclarations[0]?.parameters as {
      type: string
      required: string[]
      properties: Record<string, { type: string; description?: string }>
    }

    expect(parameters.type).toBe('object')
    expect(parameters.required).toEqual(['path'])
    expect(parameters.properties.path?.type).toBe('string')
    expect(parameters.properties.path?.description).toBe('Workspace-relative path')
  })

  /**
   * The near-miss this guards: pruning only the top level looks correct against a flat
   * schema and fails on any tool with a nested array or object argument.
   */
  it('prunes nested schemas too, not just the top level', () => {
    const nested: ToolDefinition = {
      name: 'apply_diff',
      description: 'Apply diffs',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: { search: { type: 'string', minLength: 1 } },
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
      },
    }

    const [wrapper] = toGeminiTools([nested]) as [{ functionDeclarations: { parameters: unknown }[] }]
    const serialized = JSON.stringify(wrapper.functionDeclarations[0]?.parameters)

    expect(serialized).not.toContain('additionalProperties')
    expect(serialized).not.toContain('minLength')
    expect(serialized).not.toContain('minItems')
    // But the shape survives.
    expect(serialized).toContain('edits')
    expect(serialized).toContain('search')
  })

  /** A property literally named `format` or `default` must not be deleted as a keyword. */
  it('does not mistake a property name for a schema keyword', () => {
    const tool: ToolDefinition = {
      name: 'write',
      description: 'w',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string' },
          default: { type: 'string' },
        },
      },
    }

    const [wrapper] = toGeminiTools([tool]) as [{ functionDeclarations: { parameters: { properties: object } }[] }]
    const properties = wrapper.functionDeclarations[0]?.parameters.properties as Record<string, unknown>

    expect(Object.keys(properties).sort()).toEqual(['default', 'format'])
  })

  it('keeps enum, which Gemini does support', () => {
    const tool: ToolDefinition = {
      name: 'mode',
      description: 'm',
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['a', 'b'] } } },
    }
    expect(JSON.stringify(toGeminiTools([tool]))).toContain('enum')
  })
})
