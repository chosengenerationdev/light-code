import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyThinking } from './thinking.js'

const apply = (
  wireFormat: Parameters<typeof applyThinking>[1],
  settings: Parameters<typeof applyThinking>[2],
  maxTokens?: number,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {}
  applyThinking(body, wireFormat, settings, maxTokens)
  return body
}

/**
 * The setting exists because every vendor spells it differently, and the failure when it is
 * spelled wrong is loud and total: an unrecognised top-level field is a 400 on *every* request,
 * not a quietly ignored hint on the hard ones.
 */
describe('translating a thinking level', () => {
  /*
   * The only setting that cannot break a gateway nobody has tested against, and therefore the
   * default. Every request behaved this way before the feature existed.
   */
  it('sends nothing at all when it was never set', () => {
    for (const wire of ['openai', 'anthropic', 'gemini'] as const) {
      expect(apply(wire, undefined)).toEqual({})
    }
  })

  it('sends reasoning_effort for the OpenAI wire format by default', () => {
    expect(apply('openai', { level: 'high' })).toEqual({ reasoning_effort: 'high' })
    expect(apply('openai', { level: 'low' })).toEqual({ reasoning_effort: 'low' })
    // Off is an omission here, not a value: there is no "effort: none".
    expect(apply('openai', { level: 'off' })).toEqual({})
  })

  /*
   * vLLM and SGLang serving Qwen3 take a chat-template switch, not an effort level. Sending
   * `reasoning_effort` there is a 400, and sending `chat_template_kwargs` to OpenAI is a 400 —
   * which is why the profile says which rather than the code guessing.
   */
  it('sends the chat-template switch for a Qwen-style endpoint', () => {
    expect(apply('openai', { level: 'high', style: 'qwen' })).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    })
    expect(apply('openai', { level: 'off', style: 'qwen' })).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    })
  })

  it('gives Anthropic a budget, and Gemini a zero when off', () => {
    expect(apply('anthropic', { level: 'medium' }, 32_000)).toMatchObject({
      thinking: { type: 'enabled' },
    })
    expect(apply('anthropic', { level: 'off' })).toEqual({})
    // Gemini is told *not* to think with a zero, so off is a value rather than an omission.
    expect(apply('gemini', { level: 'off' })).toEqual({ thinkingConfig: { thinkingBudget: 0 } })
  })

  /*
   * Anthropic rejects a budget that is not smaller than max_tokens. The two are edited in
   * different places, so nothing stops a small max and a high level — and the 400 would name a
   * field the user had not touched.
   */
  it('clamps the budget under max_tokens rather than letting the request fail', () => {
    const body = apply('anthropic', { level: 'high' }, 4_096)
    const thinking = body.thinking as { budget_tokens: number }
    expect(thinking.budget_tokens).toBeLessThan(4_096)
    expect(thinking.budget_tokens).toBeGreaterThan(0)
  })

  it('rises with the level where the level is a number', () => {
    const budget = (level: 'low' | 'medium' | 'high') =>
      (apply('anthropic', { level }, 200_000).thinking as { budget_tokens: number }).budget_tokens
    expect(budget('low')).toBeLessThan(budget('medium'))
    expect(budget('medium')).toBeLessThan(budget('high'))
  })
})

describe('the wiring', () => {
  const read = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')

  it('is applied by every adapter, with its own wire format', () => {
    expect(read('openai.ts')).toContain("applyThinking(body, 'openai'")
    expect(read('anthropic.ts')).toContain("applyThinking(body, 'anthropic'")
    expect(read('gemini.ts')).toContain("applyThinking(body, 'gemini'")
  })

  /*
   * Sampling is the other half of making a mid-size model reliable, and it is unset by default
   * for the same reason: a default would change how somebody's working model behaves without
   * their asking.
   */
  it('sends temperature and top_p only when they are set', () => {
    const openai = read('openai.ts')
    expect(openai).toContain('if (this.profile.temperature !== undefined)')
    expect(openai).toContain('if (this.profile.topP !== undefined)')
  })

  /*
   * A seat's override must not reach the chat model. The profile object is shared with everything
   * else using it this turn, so the override is a copy — a mutation would be the Agents tab
   * quietly changing how the assistant itself thinks.
   */
  it('applies a seat override to a copy of the profile', () => {
    const bridge = readFileSync(
      fileURLToPath(new URL('../host/bridge.ts', import.meta.url)),
      'utf8',
    )
    const at = bridge.indexOf('const seatProfile =')
    expect(at).toBeGreaterThan(-1)
    // Built from the copy, not the shared profile. Sliced rather than matched on exact
    // formatting, which prettier owns and which says nothing about the property being asserted.
    const call = bridge.slice(at, bridge.indexOf('logger,', at))
    expect(call).toContain('createChatProvider(')
    expect(call).toContain('seatProfile,')
  })
})
