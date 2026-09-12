import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { countUnansweredToolCalls, repairUnansweredToolCalls } from './repairHistory.js'
import type { ChatMessage } from '../providers/types.js'

const call = (id: string, name = 'read_file'): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: '{}' }],
})

const answer = (id: string): ChatMessage => ({ role: 'tool', toolCallId: id, content: 'ok' })

/**
 * The reported failure: a chat that answered every message with an HTTP 400 about tool_call_ids,
 * permanently, because a broken call/result pair was in the stored history and went out with every
 * request from then on. Starting a new chat was the only escape, and nothing said so.
 */
describe('repairing an unanswered tool call', () => {
  it('leaves a healthy conversation exactly as it was', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      call('a'),
      answer('a'),
      { role: 'assistant', content: 'done' },
    ]
    expect(repairUnansweredToolCalls(messages)).toEqual(messages)
    expect(countUnansweredToolCalls(messages)).toBe(0)
  })

  /*
   * Immediately after its own call, not appended at the end. Providers require the result to
   * follow the call, and several require it to follow *immediately* — a repair that satisfied the
   * counting rule but not the ordering one would be rejected just the same, which is the sort of
   * fix that looks right and changes nothing.
   */
  it('answers the call in place, keeping the order the provider requires', () => {
    const repaired = repairUnansweredToolCalls([
      { role: 'user', content: 'hello' },
      call('a'),
      { role: 'user', content: 'still there?' },
    ])

    expect(repaired.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(repaired[2]).toMatchObject({ toolCallId: 'a' })
    expect(String(repaired[2]?.content)).toContain('never reported a result')
  })

  it('keeps the assistant message rather than deleting it', () => {
    const repaired = repairUnansweredToolCalls([call('a', 'apply_diff')])
    // Deleting it would lose the record of what was attempted, and leave the model looking at a
    // turn where it had asked for nothing.
    expect(repaired[0]).toMatchObject({ role: 'assistant' })
    expect(repaired).toHaveLength(2)
  })

  it('repairs several, including one already answered among them', () => {
    const messages: ChatMessage[] = [call('a'), answer('a'), call('b'), call('c')]
    expect(countUnansweredToolCalls(messages)).toBe(2)

    const repaired = repairUnansweredToolCalls(messages)
    expect(repaired.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ])
  })

  it('answers a repeated id once, not twice', () => {
    /*
     * Two calls sharing an id is malformed input, and there is no repair that makes it valid —
     * the point is to not make it *worse*. One id gets one result: emitting a second would be the
     * same class of error from the other direction, and providers reject a duplicated result as
     * readily as a missing one.
     */
    const repaired = repairUnansweredToolCalls([call('a'), call('a')])
    expect(repaired.filter((message) => message.role === 'tool')).toHaveLength(1)
    expect(repaired.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('handles an assistant message carrying several calls', () => {
    const repaired = repairUnansweredToolCalls([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read_file', arguments: '{}' },
          { id: 'b', name: 'list_files', arguments: '{}' },
        ],
      },
    ])
    expect(repaired.filter((message) => message.role === 'tool').map((m) => m.toolCallId)).toEqual([
      'a',
      'b',
    ])
  })
})

describe('the loop no longer creates one', () => {
  const loop = readFileSync(fileURLToPath(new URL('./loop.ts', import.meta.url)), 'utf8')

  /*
   * The assistant message is added before the tool runs, which it must be. So the window between
   * the two has to be closed rather than made unlikely: anything escaping it leaves a call nothing
   * answers, and the conversation is unusable from then on.
   */
  it('turns a throwing tool into an error result', () => {
    const body = loop.slice(loop.indexOf('conversation.addAssistantMessage(assistantText, [toolCall])'))
    const guard = body.indexOf('try {')
    const record = body.indexOf('conversation.addToolResultMessage(toolCall.id, forModel)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(record)
    expect(body.slice(guard, record)).toContain('catch (error)')
  })

  it('repairs the history it sends, so an already-broken task heals', () => {
    expect(loop).toContain('repairUnansweredToolCalls(conversation.toModelMessages())')
  })
})
