import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, StreamChunk } from '../providers/types.js'
import { applyReportedUsage, computeBreakdown, computeCacheStats, estimateTokens } from './budget.js'
import { buildSummaryPrompt, compactHistory, findSafeBoundary, isSummaryMessage, shouldCompact } from './compact.js'
import { dropSupersededReads } from './supersede.js'

function readCall(id: string, path: string, extra: Record<string, unknown> = {}): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ path, ...extra }) }],
  }
}

describe('dropSupersededReads', () => {
  it('replaces an earlier read of the same file, keeping the latest', () => {
    const messages: ChatMessage[] = [
      readCall('c1', 'src/a.ts'),
      { role: 'tool', toolCallId: 'c1', content: 'OLD CONTENTS'.repeat(50) },
      readCall('c2', 'src/a.ts'),
      { role: 'tool', toolCallId: 'c2', content: 'NEW CONTENTS' },
    ]

    const { messages: result, supersededCount } = dropSupersededReads(messages)

    expect(supersededCount).toBe(1)
    expect(result[1]?.content).toMatch(/^\[Superseded/)
    expect(result[3]?.content).toBe('NEW CONTENTS')
  })

  /** Deleting the message would orphan the tool call and every provider rejects that. */
  it('keeps the tool message so the call/result pairing survives', () => {
    const messages: ChatMessage[] = [
      readCall('c1', 'src/a.ts'),
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(500) },
      readCall('c2', 'src/a.ts'),
      { role: 'tool', toolCallId: 'c2', content: 'new' },
    ]

    const { messages: result } = dropSupersededReads(messages)

    expect(result).toHaveLength(4)
    expect(result[1]).toMatchObject({ role: 'tool', toolCallId: 'c1' })
  })

  it('leaves reads of different files alone', () => {
    const messages: ChatMessage[] = [
      readCall('c1', 'src/a.ts'),
      { role: 'tool', toolCallId: 'c1', content: 'a contents'.repeat(50) },
      readCall('c2', 'src/b.ts'),
      { role: 'tool', toolCallId: 'c2', content: 'b contents'.repeat(50) },
    ]

    expect(dropSupersededReads(messages).supersededCount).toBe(0)
  })

  /** Lines 1-100 and 200-300 are not the same read; dropping the first loses content. */
  it('does not supersede a different range of the same file', () => {
    const messages: ChatMessage[] = [
      readCall('c1', 'src/a.ts', { offset: 0, limit: 100 }),
      { role: 'tool', toolCallId: 'c1', content: 'first hundred lines'.repeat(50) },
      readCall('c2', 'src/a.ts', { offset: 200, limit: 100 }),
      { role: 'tool', toolCallId: 'c2', content: 'later lines'.repeat(50) },
    ]

    expect(dropSupersededReads(messages).supersededCount).toBe(0)
  })

  /** Running the tests twice gives two real answers; the earlier one is not redundant. */
  it('never supersedes a command result', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'execute_command', arguments: '{"command":"npm test"}' }] },
      { role: 'tool', toolCallId: 'c1', content: '3 failing'.repeat(50) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'execute_command', arguments: '{"command":"npm test"}' }] },
      { role: 'tool', toolCallId: 'c2', content: '0 failing'.repeat(50) },
    ]

    expect(dropSupersededReads(messages).supersededCount).toBe(0)
  })

  it('reports the characters reclaimed', () => {
    const messages: ChatMessage[] = [
      readCall('c1', 'a.ts'),
      { role: 'tool', toolCallId: 'c1', content: 'y'.repeat(1000) },
      readCall('c2', 'a.ts'),
      { role: 'tool', toolCallId: 'c2', content: 'new' },
    ]

    expect(dropSupersededReads(messages).charactersSaved).toBeGreaterThan(800)
  })

  it('leaves a result already shorter than the marker alone', () => {
    const messages: ChatMessage[] = [
      readCall('c1', 'a.ts'),
      { role: 'tool', toolCallId: 'c1', content: '' },
      readCall('c2', 'a.ts'),
      { role: 'tool', toolCallId: 'c2', content: 'new' },
    ]

    expect(dropSupersededReads(messages).supersededCount).toBe(0)
  })
})

describe('findSafeBoundary', () => {
  const withToolCall: ChatMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: 'result' },
    { role: 'user', content: 'thanks' },
  ]

  it('refuses to cut between a call and its result', () => {
    // Index 2 would leave the tool_use at index 1 unanswered.
    expect(findSafeBoundary(withToolCall, 2)).toBe(1)
  })

  it('allows a cut after the result', () => {
    expect(findSafeBoundary(withToolCall, 3)).toBe(3)
  })

  it('walks backwards, never forwards, so recent turns are never discarded', () => {
    const boundary = findSafeBoundary(withToolCall, 2)
    expect(boundary).toBeLessThan(2)
  })

  it('returns 0 when no safe cut exists, meaning "do not compact"', () => {
    const unsafe: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'r' },
    ]
    expect(findSafeBoundary(unsafe, 1)).toBe(0)
  })

  it('handles parallel tool calls in one assistant message', () => {
    const parallel: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'x', arguments: '{}' },
          { id: 'c2', name: 'y', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: 'r1' },
      { role: 'tool', toolCallId: 'c2', content: 'r2' },
      { role: 'user', content: 'next' },
    ]

    // Only after both results is the cut safe.
    expect(findSafeBoundary(parallel, 2)).toBe(0)
    expect(findSafeBoundary(parallel, 3)).toBe(3)
  })
})

describe('shouldCompact', () => {
  const messages: ChatMessage[] = Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'x' }))

  it('triggers past the threshold', () => {
    expect(shouldCompact(messages, 80_000, 100_000)).toBe(true)
  })

  it('does not trigger below it', () => {
    expect(shouldCompact(messages, 40_000, 100_000)).toBe(false)
  })

  it('never triggers on a short conversation, however large the messages', () => {
    expect(shouldCompact([{ role: 'user', content: 'x' }], 999_999, 100_000)).toBe(false)
  })

  it('does not divide by an unknown window', () => {
    expect(shouldCompact(messages, 999_999, 0)).toBe(false)
  })
})

describe('buildSummaryPrompt', () => {
  it('asks for the things §12 says must survive', () => {
    const prompt = buildSummaryPrompt([{ role: 'user', content: 'fix it' }])
    expect(prompt).toMatch(/file path/i)
    expect(prompt).toMatch(/command/i)
    expect(prompt).toMatch(/decision/i)
  })

  it('includes tool calls, so the summary can mention what was run', () => {
    const prompt = buildSummaryPrompt([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'execute_command', arguments: '{"command":"npm test"}' }] },
    ])
    expect(prompt).toContain('execute_command')
    expect(prompt).toContain('npm test')
  })
})

/** A provider that returns a fixed summary, or fails, without any network. */
function fakeProvider(chunks: StreamChunk[]): ChatProvider {
  return {
    async *streamChat() {
      for (const chunk of chunks) yield chunk
    },
  }
}

describe('compactHistory', () => {
  function longHistory(): ChatMessage[] {
    return [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `message ${i} with enough text to be worth summarising`,
      })),
    ]
  }

  it('replaces old turns with a summary and keeps recent ones verbatim', async () => {
    const messages = longHistory()
    const result = await compactHistory(messages, fakeProvider([{ type: 'text', text: 'short notes' }, { type: 'done' }]), {
      keepRecent: 6,
    })

    expect(result.compacted).toBe(true)
    expect(result.messages.length).toBeLessThan(messages.length)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(isSummaryMessage(result.messages[1] as ChatMessage)).toBe(true)
    // The last six survive untouched.
    expect(result.messages.slice(-6)).toEqual(messages.slice(-6))
  })

  it('keeps exactly one system message, since Anthropic and Gemini take only one', async () => {
    const result = await compactHistory(longHistory(), fakeProvider([{ type: 'text', text: 'notes' }, { type: 'done' }]), {
      keepRecent: 6,
    })
    expect(result.messages.filter((m) => m.role === 'system')).toHaveLength(1)
  })

  /** Losing the conversation because the summary call failed is worse than being near the limit. */
  it('leaves history untouched when summarisation errors', async () => {
    const messages = longHistory()
    const result = await compactHistory(messages, fakeProvider([{ type: 'error', error: 'gateway down' }]), {
      keepRecent: 6,
    })

    expect(result.compacted).toBe(false)
    expect(result.messages).toEqual(messages)
  })

  it('leaves history untouched when the provider throws', async () => {
    const throwing: ChatProvider = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('socket closed')
      },
    }
    const messages = longHistory()
    expect((await compactHistory(messages, throwing, { keepRecent: 6 })).compacted).toBe(false)
  })

  it('leaves history untouched when the summary is empty', async () => {
    const result = await compactHistory(longHistory(), fakeProvider([{ type: 'text', text: '   ' }, { type: 'done' }]), {
      keepRecent: 6,
    })
    expect(result.compacted).toBe(false)
  })

  /** A model can return more than it was given; compacting into something bigger is worse. */
  it('refuses a summary larger than what it replaced', async () => {
    const enormous = 'padding '.repeat(5_000)
    const result = await compactHistory(longHistory(), fakeProvider([{ type: 'text', text: enormous }, { type: 'done' }]), {
      keepRecent: 6,
    })
    expect(result.compacted).toBe(false)
  })

  it('does nothing when there is little to compact', async () => {
    const short: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
    expect((await compactHistory(short, fakeProvider([{ type: 'text', text: 'notes' }]), { keepRecent: 6 })).compacted).toBe(
      false,
    )
  })

  it('never splits a tool call from its result', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `filler ${i}` })),
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'result' },
      ...Array.from({ length: 4 }, (_, i) => ({ role: 'user' as const, content: `recent ${i}` })),
    ]

    const result = await compactHistory(messages, fakeProvider([{ type: 'text', text: 'notes' }, { type: 'done' }]), {
      keepRecent: 5,
    })

    // Every surviving tool result still has its call present.
    const callIds = new Set(
      result.messages.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [])),
    )
    for (const message of result.messages) {
      if (message.role === 'tool') expect(callIds.has(message.toolCallId)).toBe(true)
    }
  })
})

describe('token accounting', () => {
  it('estimates zero for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('rounds up, so the bar never overstates remaining room', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('separates results from history, since results dominate', () => {
    const breakdown = computeBreakdown(
      [
        { role: 'system', content: 'x'.repeat(400) },
        { role: 'user', content: 'y'.repeat(40) },
        { role: 'tool', toolCallId: 'c1', content: 'z'.repeat(4000) },
      ],
      [{ name: 'read_file', description: 'reads', parameters: { type: 'object' } }],
      100_000,
    )

    expect(breakdown.system).toBe(100)
    expect(breakdown.history).toBe(10)
    expect(breakdown.results).toBe(1000)
    expect(breakdown.toolDefinitions).toBeGreaterThan(0)
    expect(breakdown.total).toBe(breakdown.system + breakdown.history + breakdown.results + breakdown.toolDefinitions)
    expect(breakdown.estimated).toBe(true)
  })

  it('counts images as non-free', () => {
    const withImage = computeBreakdown(
      [{ role: 'user', content: 'what is this', images: [{ mediaType: 'image/png', data: 'AAAA' }] }],
      [],
      100_000,
    )
    expect(withImage.history).toBeGreaterThan(1_000)
  })

  it('computes a cache hit rate from reported usage', () => {
    const stats = computeCacheStats({ inputTokens: 200, cacheReadTokens: 800 })
    expect(stats.hitRate).toBeCloseTo(0.8)
    expect(stats.readTokens).toBe(800)
  })

  it('reports no hit rate when the provider says nothing', () => {
    expect(computeCacheStats(undefined).hitRate).toBeUndefined()
  })

  it('replaces the estimated total with reported usage, keeping proportions', () => {
    const estimated = computeBreakdown(
      [
        { role: 'system', content: 'x'.repeat(400) },
        { role: 'tool', toolCallId: 'c1', content: 'z'.repeat(400) },
      ],
      [],
      100_000,
    )
    const corrected = applyReportedUsage(estimated, { inputTokens: 400, cacheReadTokens: 0 })

    expect(corrected.total).toBe(400)
    expect(corrected.estimated).toBe(false)
    // Still split roughly evenly, as the estimate had it.
    expect(corrected.system).toBe(corrected.results)
  })

  it('leaves the estimate alone when nothing was reported', () => {
    const estimated = computeBreakdown([{ role: 'user', content: 'hi' }], [], 100_000)
    expect(applyReportedUsage(estimated, undefined)).toEqual(estimated)
  })
})
