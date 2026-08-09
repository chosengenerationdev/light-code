import { describe, expect, it } from 'vitest'
import { CODE_MODE } from '../modes/builtin.js'
import { AnthropicProvider } from '../providers/anthropic.js'
import { NoAuthStrategy } from '../providers/auth/apiKey.js'
import { GeminiProvider } from '../providers/gemini.js'
import { OpenAIProvider } from '../providers/openai.js'
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { createDefaultToolRegistry } from '../tools/index.js'
import type { ProviderProfile, StreamChunk } from '../providers/types.js'
import { toToolDefinitions } from '../tools/registry.js'
import { toolsForMode } from '../modes/resolve.js'

/**
 * §12's central claim: **the static prefix must be stable within a session.** Tool
 * definitions sit at the front of the prompt, so any variation between turns invalidates
 * the cache prefix and every message after it.
 *
 * The plan's Verify step is "run a 40-turn session and watch the token bar; if cache hit
 * rate collapses, something is mutating the prefix". That is a good live check but a slow
 * and indirect one. These tests assert the property directly, so a regression fails in CI
 * rather than showing up as a bill.
 */

class RecordingHttpClient implements HttpClient {
  public bodies: string[] = []

  async request(_url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.bodies.push(options.body ?? '')
    return {
      status: 200,
      headers: {},
      text: async () => '',
      json: async <T>() => ({}) as T,
      // An immediately-closed stream: these tests care about the request, not the response.
      body: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }
  }
}

async function drain(generator: AsyncGenerator<StreamChunk>): Promise<void> {
  // Consumed for effect: the request is what these tests inspect, not the response.
  for await (const chunk of generator) void chunk
}

/** The real built-in tool set, so this exercises what actually ships. */
function realToolDefinitions() {
  return toToolDefinitions(toolsForMode(createDefaultToolRegistry(), CODE_MODE))
}

const profiles: Record<string, ProviderProfile> = {
  openai: {
    id: 'o',
    label: 'OpenAI',
    wireFormat: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    auth: { type: 'none' },
  },
  anthropic: {
    id: 'a',
    label: 'Anthropic',
    wireFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4',
    auth: { type: 'none' },
  },
  gemini: {
    id: 'g',
    label: 'Gemini',
    wireFormat: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-pro',
    auth: { type: 'none' },
  },
}

describe('tool definitions are byte-stable across turns', () => {
  it('produces an identical definition list on every call', () => {
    const first = JSON.stringify(realToolDefinitions())
    const second = JSON.stringify(realToolDefinitions())
    expect(second).toBe(first)
  })

  it.each(['openai', 'anthropic', 'gemini'] as const)('%s sends a byte-identical tool block each turn', async (kind) => {
    const client = new RecordingHttpClient()
    const profile = profiles[kind] as ProviderProfile
    const provider =
      kind === 'anthropic'
        ? new AnthropicProvider(client, profile, new NoAuthStrategy())
        : kind === 'gemini'
          ? new GeminiProvider(client, profile, new NoAuthStrategy())
          : new OpenAIProvider(client, profile, new NoAuthStrategy())

    const tools = realToolDefinitions()

    // Three turns with a growing conversation, exactly as the loop does it.
    await drain(provider.streamChat([{ role: 'user', content: 'one' }], { tools }))
    await drain(
      provider.streamChat([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'two' }], {
        tools,
      }),
    )
    await drain(
      provider.streamChat(
        [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'two' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
          { role: 'tool', toolCallId: 'c1', content: 'contents' },
        ],
        { tools },
      ),
    )

    expect(client.bodies).toHaveLength(3)
    const toolBlocks = client.bodies.map((body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      return JSON.stringify(parsed.tools)
    })

    expect(toolBlocks[1]).toBe(toolBlocks[0])
    expect(toolBlocks[2]).toBe(toolBlocks[0])
    // Guard against the whole assertion passing vacuously on an absent tool block.
    expect(toolBlocks[0]).not.toBe(undefined)
    expect(toolBlocks[0]?.length ?? 0).toBeGreaterThan(50)
  })

  /**
   * The system prompt is the other half of the prefix. Anthropic and Gemini carry it in a
   * dedicated field rather than a message, so it has its own way of drifting.
   */
  it('keeps the system field stable for Anthropic across turns', async () => {
    const client = new RecordingHttpClient()
    const provider = new AnthropicProvider(client, profiles.anthropic as ProviderProfile, new NoAuthStrategy())
    const system = { role: 'system' as const, content: 'You are Light Code working in /repo' }

    await drain(provider.streamChat([system, { role: 'user', content: 'one' }]))
    await drain(provider.streamChat([system, { role: 'user', content: 'one' }, { role: 'user', content: 'two' }]))

    const systems = client.bodies.map((body) => (JSON.parse(body) as { system?: string }).system)
    expect(systems[0]).toBe('You are Light Code working in /repo')
    expect(systems[1]).toBe(systems[0])
  })

  it('keeps systemInstruction stable for Gemini across turns', async () => {
    const client = new RecordingHttpClient()
    const provider = new GeminiProvider(client, profiles.gemini as ProviderProfile, new NoAuthStrategy())
    const system = { role: 'system' as const, content: 'You are Light Code working in /repo' }

    await drain(provider.streamChat([system, { role: 'user', content: 'one' }]))
    await drain(provider.streamChat([system, { role: 'user', content: 'one' }, { role: 'user', content: 'two' }]))

    const instructions = client.bodies.map((body) => JSON.stringify((JSON.parse(body) as Record<string, unknown>).systemInstruction))
    expect(instructions[1]).toBe(instructions[0])
  })

  /**
   * Key ordering is part of byte stability: two objects that are deeply equal but
   * serialise differently defeat a prefix cache just as thoroughly as different content.
   */
  it('serialises tool definitions in a stable key order', () => {
    const serialised = realToolDefinitions().map((tool) => Object.keys(tool).join(','))
    const first = serialised[0]
    for (const keys of serialised) expect(keys).toBe(first)
  })
})
