import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { toToolDefinitions } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import { NoAuthStrategy } from './auth/apiKey.js'
import { isGeminiModel, requiresSignature, restoreArguments, SKIP_SIGNATURE, toGeminiCompatTools } from './geminiCompat.js'
import { toGeminiContents } from './gemini.js'
import { OpenAIProvider } from './openai.js'
import { toOpenAITools } from './schema.js'
import type { ChatMessage, ProviderProfile, StreamChunk, ToolDefinition } from './types.js'

/*
 * Gemini through the office's OpenAI-compatible endpoint, asked for with one condition: Qwen, in daily
 * use on the same wire format, must not change. The last block pins that.
 */

const gateway = 'https://llm.corp.example/v1'
const profile = (model: string, extra: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: 'p', label: 'Gateway', wireFormat: 'openai', baseUrl: gateway, model, auth: { type: 'none' }, ...extra,
})

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
  return new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(text)); c.close() } })
}

function recording(events: unknown[]): { http: HttpClient; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const http: HttpClient = {
    async request(_url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
      bodies.push(JSON.parse(options?.body ?? '{}') as Record<string, unknown>)
      return { status: 200, headers: {}, text: async () => '', json: async <T>() => ({}) as T, body: sse(events) }
    },
  }
  return { http, bodies }
}

async function run(model: string, events: unknown[], messages: ChatMessage[] = [{ role: 'user', content: 'go' }], tools: ToolDefinition[] = [], extra: Partial<ProviderProfile> = {}) {
  const { http, bodies } = recording(events)
  const chunks: StreamChunk[] = []
  for await (const chunk of new OpenAIProvider(http, profile(model, extra), new NoAuthStrategy()).streamChat(messages, { tools })) chunks.push(chunk)
  return { chunks, body: bodies[0] as Record<string, unknown> }
}

const callTool: ToolDefinition = {
  name: 'call_tool',
  description: 'Calls a tool by name.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The tool.' },
      arguments: { type: 'object', additionalProperties: {}, description: "The tool's arguments." },
    },
    required: ['name'],
    additionalProperties: false,
  },
}

describe('which models are Gemini', () => {
  it('recognises Gemini however a gateway names it, and nothing else', () => {
    for (const model of ['gemini-4-pro', 'google/gemini-4', 'corp-Gemini-alias', 'gemini-2.5-flash']) expect(isGeminiModel(model)).toBe(true)
    for (const model of ['qwen3.8-27b', 'gpt-4o', 'deepseek-chat', 'claude-sonnet']) expect(isGeminiModel(model)).toBe(false)
    expect(isGeminiModel('my-model', 'https://generativelanguage.googleapis.com/v1beta/openai')).toBe(true)
  })

  it('fills missing signatures from Gemini 3 on, including 4 and unversioned aliases', () => {
    for (const model of ['gemini-4-pro', 'gemini-3-flash', 'gemini', 'corp-gemini']) expect(requiresSignature(model)).toBe(true)
    for (const model of ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro']) expect(requiresSignature(model)).toBe(false)
  })
})

describe('schemas Gemini accepts', () => {
  it('keeps what a dropped keyword said, in the description', () => {
    const [tool] = toGeminiCompatTools([{
      name: 't', description: 'd',
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many.', minimum: 1, maximum: 50, default: 10 } } },
    }]).tools as [{ function: { parameters: { properties: { limit: Record<string, unknown> } } } }]
    expect(tool.function.parameters.properties.limit).toEqual({ type: 'integer', description: 'How many. Default: 10. Minimum 1. Maximum 50.' })
  })

  it("offers a free-form object as JSON text, and hands the tool an object again", () => {
    const { tools, reshaped } = toGeminiCompatTools([callTool])
    const args = (tools[0] as { function: { parameters: { properties: Record<string, { type: string; description: string }> } } }).function.parameters.properties.arguments
    expect(args?.type).toBe('string')
    expect(args?.description).toMatch(/as JSON text/)
    expect(JSON.parse(restoreArguments('{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}', reshaped.get('call_tool')))).toEqual({
      name: 'read_file',
      arguments: { path: 'a.ts' },
    })
    // A model that sends the object anyway is passed through untouched.
    expect(JSON.parse(restoreArguments('{"name":"x","arguments":{"a":1}}', reshaped.get('call_tool')))).toEqual({ name: 'x', arguments: { a: 1 } })
  })

  it('inlines references, makes null unions nullable, and turns number enums into strings and back', () => {
    const { tools, reshaped } = toGeminiCompatTools([{
      name: 't', description: 'd',
      parameters: {
        type: 'object',
        $defs: { Mode: { type: 'string', enum: ['fast', 'safe'] } },
        properties: {
          mode: { $ref: '#/$defs/Mode' },
          note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          level: { type: 'integer', enum: [1, 2, 3] },
          items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false } },
        },
      },
    }])
    const props = (tools[0] as { function: { parameters: { properties: Record<string, Record<string, unknown>> } } }).function.parameters.properties
    expect(props.mode).toEqual({ type: 'string', enum: ['fast', 'safe'] })
    expect(props.note).toEqual({ type: 'string', nullable: true })
    expect(props.level).toEqual({ type: 'string', enum: ['1', '2', '3'] })
    expect(props.items).toEqual({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } })
    expect(JSON.parse(restoreArguments('{"level":"2"}', reshaped.get('t')))).toEqual({ level: 2 })
  })

  it('converts every tool Light Code defines into a schema with nothing Gemini refuses', async () => {
    const definitions = toToolDefinitions(await allTools())
    expect(definitions.length).toBeGreaterThan(90)
    const problems: string[] = []
    for (const tool of toGeminiCompatTools(definitions).tools as { function: { name: string; parameters: unknown } }[]) {
      walk(tool.function.parameters, `${tool.function.name}`, true, problems)
    }
    expect(problems).toEqual([])
  }, 60_000)

  it('describes every parameter of every tool, which Gemini leans on more than most models', async () => {
    const missing: string[] = []
    for (const tool of toToolDefinitions(await allTools())) {
      const properties = ((tool.parameters as { properties?: Record<string, { description?: unknown }> }).properties ?? {})
      for (const [name, schema] of Object.entries(properties)) {
        if (typeof schema.description !== 'string' || schema.description.length === 0) missing.push(`${tool.name}.${name}`)
      }
    }
    expect(missing).toEqual([])
  }, 60_000)
})

describe('Gemini over the OpenAI-compatible endpoint', () => {
  it('keeps the thought signature of a call and sends it back next time', async () => {
    const { chunks } = await run('gemini-4-pro', [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' }, extra_content: { google: { thought_signature: 'SIG1' } } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ])
    const call = chunks.find((chunk) => chunk.type === 'toolCall')
    expect(call).toEqual({ type: 'toolCall', toolCall: { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}', signature: 'SIG1' } })

    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}', signature: 'SIG1' }] },
      { role: 'tool', toolCallId: 'c1', content: '' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'list_files', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c2', content: 'a.ts' },
    ]
    const { body } = await run('gemini-4-pro', ['[DONE]'], history)
    const messages = body.messages as Record<string, unknown>[]
    expect((messages[1]?.tool_calls as Record<string, unknown>[])[0]?.extra_content).toEqual({ google: { thought_signature: 'SIG1' } })
    // A call with no signature (another model, an older chat) gets Google's skip placeholder rather than a 400.
    expect((messages[3]?.tool_calls as Record<string, unknown>[])[0]?.extra_content).toEqual({ google: { thought_signature: SKIP_SIGNATURE } })
    expect(messages[2]?.content).toBe('(no output)')
  })

  it('runs a call from a stream that ends with "stop" and no call id, with its arguments restored', async () => {
    const { chunks, body } = await run(
      'gemini-4-pro',
      [
        { choices: [{ delta: { tool_calls: [{ function: { name: 'call_tool', arguments: '{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ],
      undefined,
      [callTool],
    )
    const call = chunks.find((chunk) => chunk.type === 'toolCall') as Extract<StreamChunk, { type: 'toolCall' }> | undefined
    expect(call?.toolCall.name).toBe('call_tool')
    expect(call?.toolCall.id).toMatch(/^call_/)
    expect(JSON.parse(call?.toolCall.arguments ?? '{}')).toEqual({ name: 'read_file', arguments: { path: 'a.ts' } })
    const sent = (body.tools as { function: { parameters: { properties: Record<string, { type: string }> } } }[])[0]
    expect(sent?.function.parameters.properties.arguments?.type).toBe('string')
  })

  it('keeps parallel calls sent without an index apart', async () => {
    const { chunks } = await run('gemini-4-pro', [
      { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{"path":"a"}' } }, { id: 'b', function: { name: 'read_file', arguments: '{"path":"b"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const calls = chunks.filter((chunk) => chunk.type === 'toolCall') as Extract<StreamChunk, { type: 'toolCall' }>[]
    expect(calls.map((c) => c.toolCall.arguments)).toEqual(['{"path":"a"}', '{"path":"b"}'])
  })

  it('shows the thoughts it was asked for, and asks only when thinking is on', async () => {
    const thinking = await run('gemini-4-pro', [{ choices: [{ delta: { content: '<thought>check the file</thought>Done.' } }] }, '[DONE]'], undefined, [], { thinking: { level: 'high' } })
    expect(thinking.body.extra_body).toEqual({ google: { thinking_config: { include_thoughts: true } } })
    expect(thinking.body.reasoning_effort).toBe('high')
    expect(thinking.chunks).toContainEqual({ type: 'reasoning', text: 'check the file' })
    expect(thinking.chunks).toContainEqual({ type: 'text', text: 'Done.' })
    expect((await run('gemini-4-pro', ['[DONE]'])).body.extra_body).toBeUndefined()
  })

  it('asks again without the thoughts field when the gateway refuses it', async () => {
    const bodies: Record<string, unknown>[] = []
    const http: HttpClient = {
      async request(_url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
        const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>
        bodies.push(body)
        if (body.extra_body !== undefined) return { status: 400, headers: {}, text: async () => 'Unknown field extra_body', json: async <T>() => ({}) as T, body: null }
        return { status: 200, headers: {}, text: async () => '', json: async <T>() => ({}) as T, body: sse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']) }
      },
    }
    const chunks: StreamChunk[] = []
    const refusing = profile('gemini-4-pro', { baseUrl: 'https://refusing.example/v1', thinking: { level: 'low' } })
    for await (const chunk of new OpenAIProvider(http, refusing, new NoAuthStrategy()).streamChat([{ role: 'user', content: 'hi' }])) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text', text: 'ok' })
    expect(bodies.map((b) => b.extra_body !== undefined)).toEqual([true, false])
  })

  it('sends signatures on the native Gemini wire too', () => {
    const { contents } = toGeminiContents(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'a', arguments: '{}', signature: 'S' }, { id: '2', name: 'b', arguments: '{}' }] },
      ],
      true,
    )
    const parts = (contents[1] as { parts: Record<string, unknown>[] }).parts
    expect(parts.map((part) => part.thoughtSignature)).toEqual(['S', SKIP_SIGNATURE])
  })
})

describe('Qwen, in daily use on the same wire, is unchanged', () => {
  const qwen = 'qwen3.8-27b'

  it('sends exactly the request it did before', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'call_tool', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: '' },
    ]
    const { body } = await run(qwen, ['[DONE]'], history, [callTool], { thinking: { level: 'high', style: 'qwen' } })
    expect(body.tools).toEqual(toOpenAITools([callTool]))
    expect(body.extra_body).toBeUndefined()
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'call_tool', arguments: '{}' } }] })
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '' })
  })

  it('still splits <think> tags, ignores <thought>, and needs a call id', async () => {
    const { chunks } = await run(qwen, [
      { choices: [{ delta: { content: '<think>plan</think><thought>x</thought>' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ])
    expect(chunks).toContainEqual({ type: 'reasoning', text: 'plan' })
    expect(chunks).toContainEqual({ type: 'text', text: '<thought>x</thought>' })
    expect(chunks.some((chunk) => chunk.type === 'toolCall')).toBe(false)
  })

  it('also gets a call it streamed but announced with "stop", which used to be dropped', async () => {
    const { chunks } = await run(qwen, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'q1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ])
    expect(chunks.filter((chunk) => chunk.type === 'toolCall')).toEqual([{ type: 'toolCall', toolCall: { id: 'q1', name: 'read_file', arguments: '{"path":"a"}' } }])
  })
})

/** Everything Gemini would refuse, or misread, anywhere in a converted schema. */
const REFUSED = ['$schema', '$ref', '$defs', 'definitions', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', 'not', 'const', 'default', 'examples', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'format', 'title']

function walk(node: unknown, where: string, isRoot: boolean, problems: string[]): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    problems.push(`${where}: not a schema`)
    return
  }
  const schema = node as Record<string, unknown>
  for (const key of REFUSED) if (key in schema) problems.push(`${where}: ${key}`)
  if (typeof schema.type !== 'string') problems.push(`${where}: no single type`)
  if (Array.isArray(schema.enum) && !schema.enum.every((value) => typeof value === 'string')) problems.push(`${where}: non-string enum`)
  if (schema.type === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, unknown>
    if (Object.keys(properties).length === 0 && !isRoot) problems.push(`${where}: object with no properties`)
    for (const [name, value] of Object.entries(properties)) walk(value, `${where}.${name}`, false, problems)
  }
  if (schema.type === 'array') walk(schema.items, `${where}[]`, false, problems)
}

/** Every tool the core source defines, found by calling its creators - the way `tools/offload.test.ts` measures. */
async function allTools(): Promise<Tool[]> {
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) files.push(full)
    }
  }
  await visit(path.join(import.meta.dirname, '..'))
  const anything: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : anything),
    apply: () => undefined,
  })
  const found = new Map<string, Tool>()
  for (const file of files) {
    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    } catch {
      continue
    }
    for (const [name, value] of Object.entries(mod)) {
      const candidates: unknown[] = []
      if (typeof value === 'function' && /^create\w*Tools?$/.test(name)) {
        for (const args of [[anything], ['fire-fs.exe'], [anything, anything], []]) {
          try {
            candidates.push((value as (...a: unknown[]) => unknown)(...args))
          } catch {
            // Wants another argument shape.
          }
        }
      } else if (name.endsWith('Tool')) candidates.push(value)
      for (const candidate of candidates.flat()) {
        const tool = candidate as Partial<Tool> | undefined
        if (tool !== undefined && tool !== null && typeof tool.name === 'string' && typeof tool.description === 'string' && (tool.parametersSchema !== undefined || tool.rawJsonSchema !== undefined)) {
          if (!found.has(tool.name)) found.set(tool.name, tool as Tool)
        }
      }
    }
  }
  return [...found.values()]
}
