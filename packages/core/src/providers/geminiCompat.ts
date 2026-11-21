import type { ToolDefinition } from './types.js'
import { normalizeObjectSchema } from './schema.js'

/**
 * Gemini behind an OpenAI-compatible endpoint, and the three things that differ from OpenAI.
 *
 * Asked for ahead of Gemini arriving at the office through an OpenAI-compatible endpoint, with one
 * condition: nothing already working (Qwen through vLLM) may change. So **everything here applies only
 * when `isGeminiModel` says so**, and the adapter calls it nowhere else.
 *
 * 1. **Thought signatures.** From Gemini 3 on, every function call carries an opaque signature that
 *    must come back with the call in the next request, or the request is refused (HTTP 400). Over the
 *    OpenAI-compatible endpoint it rides on the tool call as `extra_content.google.thought_signature`.
 *    It is kept on `ToolCall.signature` and returned. A call that has none - history from another
 *    model, a chat reopened from before this existed - gets Google's documented placeholder, which
 *    tells the server to skip the check for that call rather than refuse the whole request.
 * 2. **Schemas.** Gemini takes an OpenAPI-flavoured subset of JSON Schema and refuses the rest. The
 *    keywords it cannot take are not just dropped: the constraint they carried (a default, a range, a
 *    pattern) is written into the parameter's description, so the model still knows it. An object
 *    with no declared properties (`call_tool`'s `arguments`, Jira's `fields`) is refused outright, so
 *    it is offered as a JSON string and turned back into an object when the call arrives - the tool
 *    never sees the difference.
 * 3. **Streaming.** Gemini may end a stream that made tool calls with `finish_reason: "stop"`, may
 *    leave out a call's `id`, and may send parallel calls without an `index`. Each is handled.
 */

/** Google's documented value for "no signature available - do not validate this call". */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator'

/** True for a Gemini model however a gateway names it: `gemini-4-pro`, `google/gemini-4`, `corp-gemini`. */
export function isGeminiModel(model: string, baseUrl = ''): boolean {
  return /gemini/i.test(model) || /generativelanguage\.googleapis\.com/i.test(baseUrl)
}

/**
 * Whether a missing signature must be filled in. Gemini 1.x and 2.x never required one; anything later
 * is assumed to (Gemini 3 does, and nothing says 4 relaxed it), and so is a model whose id names no
 * version at all - a gateway alias - since the placeholder is accepted where it is not needed.
 */
export function requiresSignature(model: string): boolean {
  return !/gemini[-_ ]?(1|2)(\b|[.-])/i.test(model)
}

/** Where a value was reshaped for Gemini, so the call can be put back: a path of property names, `[]` for array items. */
export interface Reshaped {
  path: string[]
  kind: 'json' | 'number'
}

export interface GeminiTools {
  tools: Record<string, unknown>[]
  /** Per tool name, what was reshaped and must be restored in its arguments. */
  reshaped: Map<string, Reshaped[]>
}

/** OpenAI-shaped tool definitions Gemini accepts, and how to undo what that took. */
export function toGeminiCompatTools(definitions: readonly ToolDefinition[]): GeminiTools {
  const reshaped = new Map<string, Reshaped[]>()
  const tools = definitions.map((tool) => {
    const root = normalizeObjectSchema(tool.parameters)
    const found: Reshaped[] = []
    const parameters = convert(root, root, [], found, 0, true) as Record<string, unknown>
    if (found.length > 0) reshaped.set(tool.name, found)
    return {
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters },
    }
  })
  return { tools, reshaped }
}

/** The call's arguments as the tool expects them: JSON strings back to objects, numbers back to numbers. */
export function restoreArguments(argumentsJson: string, reshaped: readonly Reshaped[] | undefined): string {
  if (reshaped === undefined || reshaped.length === 0) return argumentsJson
  let args: unknown
  try {
    args = JSON.parse(argumentsJson.length > 0 ? argumentsJson : '{}')
  } catch {
    return argumentsJson
  }
  for (const entry of reshaped) restoreAt(args, entry.path, entry.kind)
  return JSON.stringify(args)
}

function restoreAt(value: unknown, path: readonly string[], kind: Reshaped['kind']): unknown {
  if (path.length === 0) {
    if (typeof value !== 'string') return value
    if (kind === 'number') {
      const number = Number(value)
      return Number.isFinite(number) && value.trim().length > 0 ? number : value
    }
    try {
      return JSON.parse(value)
    } catch {
      // Not JSON after all: handed on as it came, and the tool's own validation says what is wrong.
      return value
    }
  }
  const [head, ...rest] = path
  if (head === '[]') {
    if (Array.isArray(value)) for (let i = 0; i < value.length; i += 1) value[i] = restoreAt(value[i], rest, kind)
    return value
  }
  if (isRecord(value) && head !== undefined && head in value) value[head] = restoreAt(value[head], rest, kind)
  return value
}

/*
 * Only the keys Gemini accepts are copied (type, description, properties, required, items, enum, nullable); every
 * other keyword is left behind, and what it said is kept in the description by `describeDropped`.
 */
const SCALARS = new Set(['string', 'number', 'integer', 'boolean'])
const MAX_DEPTH = 12

function convert(
  schema: unknown,
  root: Record<string, unknown>,
  path: string[],
  found: Reshaped[],
  depth: number,
  isRoot = false,
): unknown {
  if (!isRecord(schema)) return { type: 'string' }
  if (depth > MAX_DEPTH) return asJsonString(schema, path, found, 'nested too deeply to describe here')

  let node: Record<string, unknown> = { ...schema }
  // References are inlined: Gemini has no `$ref`, and dropping one would leave an empty schema.
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, root)
    if (target === undefined) return asJsonString(node, path, found, 'a structured value')
    const { $ref: _ref, ...siblings } = node
    void _ref
    node = { ...target, ...siblings }
  }
  if (Array.isArray(node.allOf)) node = mergeAllOf(node, root)

  // `type: ["string", "null"]` and `anyOf` / `oneOf` unions.
  const union = unionOf(node, root)
  if (union !== undefined) {
    const nullable = union.some((branch) => branch.type === 'null')
    const branches = union.filter((branch) => branch.type !== 'null')
    const describedBase = baseDescription(node)
    if (branches.length === 1) {
      const merged = { ...(branches[0] as Record<string, unknown>) }
      if (describedBase !== undefined && merged.description === undefined) merged.description = describedBase
      const converted = convert(merged, root, path, found, depth + 1) as Record<string, unknown>
      if (nullable) converted.nullable = true
      return converted
    }
    const allEnums = branches.every((branch) => Array.isArray(branch.enum) || branch.const !== undefined)
    if (allEnums) {
      const values = branches.flatMap((branch) => (Array.isArray(branch.enum) ? branch.enum : [branch.const]))
      return convert({ ...withoutUnion(node), enum: values, ...(nullable ? { nullable: true } : {}) }, root, path, found, depth + 1)
    }
    const allScalars = branches.every((branch) => typeof branch.type === 'string' && SCALARS.has(branch.type))
    if (allScalars) {
      const types = branches.map((branch) => branch.type as string)
      const chosen = types.includes('string') ? 'string' : types[0]
      const note = `Accepts ${types.join(' or ')}.`
      return convert(
        { ...withoutUnion(node), type: chosen, description: join(baseDescription(node), note), ...(nullable ? { nullable: true } : {}) },
        root, path, found, depth + 1,
      )
    }
    return asJsonString(node, path, found, describeUnion(branches))
  }

  const type = node.type
  const notes = describeDropped(node)
  const out: Record<string, unknown> = {}
  if (typeof type === 'string') out.type = type

  if (type === 'object' || (type === undefined && isRecord(node.properties))) {
    out.type = 'object'
    const properties = isRecord(node.properties) ? node.properties : {}
    const names = Object.keys(properties)
    if (names.length === 0 && !isRoot) return asJsonString(node, path, found, 'an object with any keys')
    const converted: Record<string, unknown> = {}
    for (const name of names) converted[name] = convert(properties[name], root, [...path, name], found, depth + 1)
    out.properties = converted
    if (Array.isArray(node.required)) {
      const required = node.required.filter((name): name is string => typeof name === 'string' && name in converted)
      if (required.length > 0) out.required = required
    }
  } else if (type === 'array') {
    out.items = node.items === undefined ? { type: 'string' } : convert(node.items, root, [...path, '[]'], found, depth + 1)
  } else if (type === undefined && node.enum === undefined) {
    // No type at all - "anything". Gemini needs one.
    return asJsonString(node, path, found, 'any JSON value')
  }

  if (Array.isArray(node.enum)) {
    const values = node.enum.filter((value) => value !== null)
    if (values.every((value) => typeof value === 'string')) {
      out.type = 'string'
      out.enum = values
    } else if (values.every((value) => typeof value === 'number')) {
      // Gemini's enums are strings. Offered as text and turned back into the number.
      out.type = 'string'
      out.enum = values.map(String)
      found.push({ path, kind: 'number' })
    } else {
      notes.push(`One of: ${values.map((value) => JSON.stringify(value)).join(', ')}.`)
    }
    if (node.enum.includes(null)) out.nullable = true
  }

  if (node.nullable === true) out.nullable = true
  const description = join(typeof node.description === 'string' ? node.description : undefined, ...notes)
  if (description !== undefined) out.description = description
  return out
}

/** A value Gemini cannot describe, offered as a JSON string and parsed back when the call arrives. */
function asJsonString(node: Record<string, unknown>, path: string[], found: Reshaped[], what: string): Record<string, unknown> {
  found.push({ path, kind: 'json' })
  const example = exampleFor(node)
  return {
    type: 'string',
    description: join(
      baseDescription(node),
      `Write ${what} as JSON text${example !== undefined ? `, for example ${example}` : ''}. It is passed to the tool as JSON, not as a string.`,
    ),
  }
}

function exampleFor(node: Record<string, unknown>): string | undefined {
  if (node.default !== undefined) return JSON.stringify(node.default)
  if (Array.isArray(node.examples) && node.examples.length > 0) return JSON.stringify(node.examples[0])
  if (node.type === 'object' || isRecord(node.properties) || node.additionalProperties !== undefined) return '{"key": "value"}'
  return undefined
}

function describeDropped(node: Record<string, unknown>): string[] {
  const notes: string[] = []
  const show = (value: unknown): string => JSON.stringify(value)
  if (node.const !== undefined) notes.push(`Must be ${show(node.const)}.`)
  if (node.default !== undefined) notes.push(`Default: ${show(node.default)}.`)
  if (typeof node.minimum === 'number') notes.push(`Minimum ${String(node.minimum)}.`)
  if (typeof node.exclusiveMinimum === 'number') notes.push(`Greater than ${String(node.exclusiveMinimum)}.`)
  if (typeof node.maximum === 'number') notes.push(`Maximum ${String(node.maximum)}.`)
  if (typeof node.exclusiveMaximum === 'number') notes.push(`Less than ${String(node.exclusiveMaximum)}.`)
  if (typeof node.multipleOf === 'number') notes.push(`A multiple of ${String(node.multipleOf)}.`)
  if (typeof node.minLength === 'number' && node.minLength > 0) notes.push(`At least ${String(node.minLength)} characters.`)
  if (typeof node.maxLength === 'number') notes.push(`At most ${String(node.maxLength)} characters.`)
  if (typeof node.pattern === 'string') notes.push(`Must match the pattern ${node.pattern}.`)
  if (typeof node.format === 'string') notes.push(`Format: ${node.format}.`)
  if (typeof node.minItems === 'number' && node.minItems > 0) notes.push(`At least ${String(node.minItems)} items.`)
  if (typeof node.maxItems === 'number') notes.push(`At most ${String(node.maxItems)} items.`)
  if (node.uniqueItems === true) notes.push('No duplicates.')
  if (Array.isArray(node.examples) && node.examples.length > 0) notes.push(`Example: ${show(node.examples[0])}.`)
  return notes
}

function describeUnion(branches: readonly Record<string, unknown>[]): string {
  const shapes = branches.map((branch) => {
    if (typeof branch.description === 'string') return branch.description
    if (isRecord(branch.properties)) return `an object with ${Object.keys(branch.properties).join(', ')}`
    return typeof branch.type === 'string' ? `a ${branch.type}` : 'a value'
  })
  return `one of these (${shapes.join('; ')})`
}

function unionOf(node: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown>[] | undefined {
  const raw = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined
  if (raw !== undefined) {
    return raw.filter(isRecord).map((branch) => (typeof branch.$ref === 'string' ? resolveRef(branch.$ref, root) ?? branch : branch))
  }
  if (Array.isArray(node.type)) {
    return node.type.filter((type): type is string => typeof type === 'string').map((type) => ({ ...withoutUnion(node), type }))
  }
  return undefined
}

function withoutUnion(node: Record<string, unknown>): Record<string, unknown> {
  const { anyOf: _a, oneOf: _o, type: _t, ...rest } = node
  void _a
  void _o
  void _t
  return rest
}

function mergeAllOf(node: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown> {
  const { allOf, ...rest } = node
  const merged: Record<string, unknown> = { ...rest }
  for (const part of allOf as unknown[]) {
    const branch = isRecord(part) && typeof part.$ref === 'string' ? resolveRef(part.$ref, root) : part
    if (!isRecord(branch)) continue
    for (const [key, value] of Object.entries(branch)) {
      if (key === 'properties' && isRecord(value)) merged.properties = { ...(isRecord(merged.properties) ? merged.properties : {}), ...value }
      else if (key === 'required' && Array.isArray(value)) merged.required = [...(Array.isArray(merged.required) ? merged.required : []), ...value]
      else if (merged[key] === undefined) merged[key] = value
    }
  }
  return merged
}

function resolveRef(ref: string, root: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ref.startsWith('#')) return undefined
  if (ref === '#') return root
  let at: unknown = root
  for (const part of ref.slice(2).split('/')) {
    if (!isRecord(at)) return undefined
    at = at[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return isRecord(at) ? at : undefined
}

function baseDescription(node: Record<string, unknown>): string | undefined {
  return typeof node.description === 'string' && node.description.length > 0 ? node.description : undefined
}

function join(...parts: (string | undefined)[]): string | undefined {
  const text = parts.filter((part): part is string => part !== undefined && part.length > 0).join(' ')
  return text.length > 0 ? text : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
