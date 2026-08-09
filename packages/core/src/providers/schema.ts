import type { ToolDefinition } from './types.js'

/**
 * Tool schema translation, per wire format.
 *
 * CLAUDE.md §11 names this as "a common source of silent tool-call failures", and the
 * failure mode is specific: a provider that does not understand a JSON Schema keyword
 * usually **ignores it** rather than rejecting the request. The model then emits arguments
 * that do not match what the tool expects, the tool errors, and nothing anywhere points at
 * the schema. So the rule here is to translate structure and drop what a provider cannot
 * represent — never to pass through and hope.
 */

/** The subset of JSON Schema every target format understands. */
const PORTABLE_KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'items',
  'enum',
  'nullable',
])

/**
 * Keywords that are valid JSON Schema but that Gemini's `functionDeclarations` rejects
 * outright with a 400 rather than ignoring. Dropped rather than forwarded.
 */
const GEMINI_UNSUPPORTED = new Set([
  '$schema',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'const',
  'default',
  'examples',
  'patternProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'format',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively strips keywords a target cannot handle. `keep` decides per key.
 *
 * Arrays are walked too: a `oneOf` inside `items` is just as fatal as one at the root, and
 * only walking the top level is the kind of near-miss that looks correct in a unit test
 * built from a flat schema.
 */
function pruneSchema(schema: unknown, keep: (key: string) => boolean): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => pruneSchema(entry, keep))
  if (!isRecord(schema)) return schema

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!keep(key)) continue
    // `properties` maps names to schemas, so its *keys* are user data and must not be
    // filtered — only the schemas underneath them.
    if (key === 'properties' && isRecord(value)) {
      const properties: Record<string, unknown> = {}
      for (const [name, propertySchema] of Object.entries(value)) {
        properties[name] = pruneSchema(propertySchema, keep)
      }
      result[key] = properties
      continue
    }
    result[key] = pruneSchema(value, keep)
  }
  return result
}

/** OpenAI nests parameters under `function`. It tolerates full JSON Schema. */
export function toOpenAITools(tools: readonly ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeObjectSchema(tool.parameters),
    },
  }))
}

/** Anthropic calls it `input_schema` and expects a bare JSON Schema object. */
export function toAnthropicTools(tools: readonly ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: normalizeObjectSchema(tool.parameters),
  }))
}

/**
 * Gemini wants `functionDeclarations` with an OpenAPI-flavoured subset. Unsupported
 * keywords are a 400, not a warning, so everything outside the portable set is pruned.
 */
export function toGeminiTools(tools: readonly ToolDefinition[]): Record<string, unknown>[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: pruneSchema(normalizeObjectSchema(tool.parameters), (key) => !GEMINI_UNSUPPORTED.has(key)),
      })),
    },
  ]
}

/**
 * Every provider expects a tool's parameters to be an object schema. A tool that takes no
 * arguments still needs `{type: "object", properties: {}}` — sending `undefined` or a bare
 * `{}` makes some gateways reject the whole request, which then looks like a model failure
 * rather than a schema one.
 */
export function normalizeObjectSchema(parameters: unknown): Record<string, unknown> {
  if (!isRecord(parameters)) return { type: 'object', properties: {} }
  const normalized: Record<string, unknown> = { ...parameters }
  if (normalized.type === undefined) normalized.type = 'object'
  if (normalized.type === 'object' && normalized.properties === undefined) normalized.properties = {}
  return normalized
}

/** Exposed for tests: the keywords considered safe everywhere. */
export function isPortableKeyword(keyword: string): boolean {
  return PORTABLE_KEYWORDS.has(keyword)
}
