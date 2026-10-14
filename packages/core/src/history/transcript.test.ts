import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'

import type { ChatMessage } from '../providers/types.js'
import { formatToolArguments, toTranscript, toolCallReason } from './transcript.js'


/**
 * The reason is lifted out of the arguments so the collapsed tool row can carry it. It must not
 * then appear twice, and it must never be invented — an absent reason is absent, not guessed.
 */
describe('the reason a tool was called', () => {
  it('is read from the call and kept out of the argument listing', () => {
    const raw = JSON.stringify({ path: 'src/api.ts', why: 'checking which gateway it points at' })
    expect(toolCallReason(raw)).toBe('checking which gateway it points at')
    expect(formatToolArguments(raw)).not.toContain('why')
    expect(formatToolArguments(raw)).toContain('src/api.ts')
  })

  it('is absent when the model gave none', () => {
    expect(toolCallReason(JSON.stringify({ path: 'a.ts' }))).toBeUndefined()
    expect(toolCallReason('')).toBeUndefined()
    expect(toolCallReason('not json')).toBeUndefined()
  })

  it('is absent rather than blank when it is empty or the wrong type', () => {
    expect(toolCallReason(JSON.stringify({ why: '  ' }))).toBeUndefined()
    expect(toolCallReason(JSON.stringify({ why: 12 }))).toBeUndefined()
  })

  /** Malformed arguments still have to render: the user needs to see what was actually sent. */
  it('leaves unparseable arguments alone', () => {
    expect(formatToolArguments('{oops')).toBe('{oops')
  })
})

/**
 * Reported from Fire Code: a formatted answer collapsed into a paragraph as the turn ended. The
 * model wrote the answer, then called attempt_completion with a short summary, and the live
 * panel replaced the first with the second. The text written must survive the result.
 */
describe('an answer followed by attempt_completion', () => {
  function turn(written: string, result: string): ChatMessage[] {
    return [
      { role: 'user', content: 'explain' },
      {
        role: 'assistant',
        content: written,
        toolCalls: [{ id: 'c1', name: 'attempt_completion', arguments: JSON.stringify({ result }) }],
      },
      { role: 'tool', toolCallId: 'c1', content: result },
    ] as ChatMessage[]
  }
  const texts = (messages: ChatMessage[]): string[] =>
    toTranscript(messages).flatMap((e) => (e.kind === 'text' && e.role === 'assistant' ? [e.content] : []))

  it('keeps the written answer and the result as two bubbles', () => {
    const answer = '## Plan\n\n- one\n- two'
    expect(texts(turn(answer, 'Done.'))).toEqual([answer, 'Done.'])
  })

  it('shows a result that repeats the answer once', () => {
    expect(texts(turn('## Plan\n- one', '## Plan\n- one\n'))).toEqual(['## Plan\n- one'])
  })

  it('is what the live path does too: a separate bubble, never an overwrite', () => {
    const bridge = readFileSync(new URL('../host/bridge.ts', import.meta.url), 'utf8')
    const start = bridge.indexOf('const streamed = textBeforeControlTool')
    expect(start).toBeGreaterThan(-1)
    const body = bridge.slice(start, start + 1200)
    expect(body).toContain('repeatsStreamedText(')
    expect(body).toContain('separate: true')
  })
})
