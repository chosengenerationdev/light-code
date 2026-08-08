import { describe, expect, it } from 'vitest'
import { Conversation } from '../agent/messages.js'
import type { ChatMessage } from '../providers/types.js'
import { redactMessage, redactTask } from './redactTask.js'
import { deriveTitle } from './titles.js'
import { toTranscript } from './transcript.js'
import { taskSummary, type Task } from './types.js'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceRoot: '/repo',
    title: 'A task',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    resultHandles: [],
    ...overrides,
  }
}

describe('deriveTitle', () => {
  it('uses the first user message', () => {
    expect(deriveTitle([{ role: 'system', content: 'sys' }, { role: 'user', content: 'Fix the login bug' }])).toBe(
      'Fix the login bug',
    )
  })

  it('ignores the system prompt, which is not something the user said', () => {
    expect(deriveTitle([{ role: 'system', content: 'You are a coding assistant for /repo' }])).toBe('Untitled task')
  })

  it('collapses a pasted multi-line prompt onto one line', () => {
    expect(deriveTitle([{ role: 'user', content: '  Fix\n\n  the   login\tbug  ' }])).toBe('Fix the login bug')
  })

  it('truncates at a word boundary when one is close to the limit', () => {
    const long = 'Refactor the authentication middleware so that it validates tokens before touching the database'
    const title = deriveTitle([{ role: 'user', content: long }])

    expect(title.length).toBeLessThanOrEqual(61)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toMatch(/\s…$/)
    // Cut on a boundary, so the last word is whole.
    expect(long.startsWith(title.slice(0, -1))).toBe(true)
  })

  it('falls back to a hard cut when there is no nearby word boundary', () => {
    const title = deriveTitle([{ role: 'user', content: 'x'.repeat(200) }])
    expect(title).toBe(`${'x'.repeat(60)}…`)
  })

  it('handles an empty message', () => {
    expect(deriveTitle([{ role: 'user', content: '   ' }])).toBe('Untitled task')
  })
})

describe('taskSummary', () => {
  it('counts only what the user said and saw', () => {
    const summary = taskSummary(
      task({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      }),
    )
    expect(summary.messageCount).toBe(2)
  })
})

describe('toTranscript', () => {
  it('renders a plain exchange', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(toTranscript(messages)).toEqual([
      { kind: 'text', role: 'user', content: 'hi' },
      { kind: 'text', role: 'assistant', content: 'hello' },
    ])
  })

  it('pairs a tool call with its result and pretty-prints the arguments', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'list_files', arguments: '{"path":"src"}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'src/index.ts' },
    ]

    expect(toTranscript(messages)).toEqual([
      { kind: 'text', role: 'user', content: 'list files' },
      {
        kind: 'tool',
        toolCall: { id: 'c1', name: 'list_files', arguments: '{\n  "path": "src"\n}', result: 'src/index.ts' },
      },
    ])
  })

  /** Regression: burying the answer inside a collapsed tool block was a real Phase 3 bug. */
  it('renders a control tool result as assistant text, not a tool block', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'done?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'attempt_completion', arguments: '{"result":"All set."}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'All set.' },
    ]

    expect(toTranscript(messages)).toEqual([
      { kind: 'text', role: 'user', content: 'done?' },
      { kind: 'text', role: 'assistant', content: 'All set.' },
    ])
  })

  it('shows a tool call with no result as unfinished rather than dropping it', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'execute_command', arguments: '{}' }],
      },
    ]
    const entries = toTranscript(messages)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'tool' })
    expect((entries[0] as { toolCall: { result?: string } }).toolCall.result).toBeUndefined()
  })

  it('keeps assistant text that accompanies a tool call', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Let me look.',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'contents' },
    ]
    const entries = toTranscript(messages)

    expect(entries[0]).toEqual({ kind: 'text', role: 'assistant', content: 'Let me look.' })
    expect(entries[1]).toMatchObject({ kind: 'tool' })
  })

  it('leaves malformed arguments as-is rather than throwing', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: 'not json' }] },
    ]
    expect((toTranscript(messages)[0] as { toolCall: { arguments: string } }).toolCall.arguments).toBe('not json')
  })
})

describe('redaction before writing', () => {
  it('removes a known secret from a tool result', () => {
    const message = redactMessage({ role: 'tool', toolCallId: 'c1', content: 'API_KEY=corp-abc123' }, ['corp-abc123'])
    expect(message.content).toBe('API_KEY=[REDACTED]')
  })

  it('catches Bearer tokens by pattern even when the value is unknown', () => {
    const message = redactMessage({ role: 'tool', toolCallId: 'c1', content: 'Authorization: Bearer eyJhbGciOi.abc' }, [])
    expect(message.content).not.toContain('eyJhbGciOi.abc')
  })

  it('redacts model-authored tool arguments, which can echo a secret back', () => {
    const redacted = redactMessage(
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'execute_command', arguments: '{"command":"curl -H \'key: corp-abc123\'"}' }],
      },
      ['corp-abc123'],
    )

    expect(redacted.role).toBe('assistant')
    expect(JSON.stringify(redacted)).not.toContain('corp-abc123')
  })

  it('preserves tool call identity so a redacted transcript still pairs up', () => {
    const redacted = redactTask(
      task({
        messages: [
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
          { role: 'tool', toolCallId: 'c1', content: 'sk-abcdefghijkl' },
        ],
      }),
      [],
    )

    const entries = toTranscript(redacted.messages)
    expect(entries).toHaveLength(1)
    expect((entries[0] as { toolCall: { result?: string } }).toolCall.result).toBe('[REDACTED]')
  })

  it('redacts the title too — it comes from a user message that may contain a key', () => {
    const redacted = redactTask(task({ title: 'use sk-abcdefghijkl please' }), [])
    expect(redacted.title).not.toContain('sk-abcdefghijkl')
  })

  it('leaves ordinary content untouched', () => {
    const redacted = redactTask(task({ messages: [{ role: 'user', content: 'fix the bug' }] }), ['corp-abc123'])
    expect(redacted.messages[0]?.content).toBe('fix the bug')
  })
})

describe('Conversation restore', () => {
  it('keeps the current system prompt rather than the stored one', () => {
    const conversation = new Conversation('CURRENT prompt for /repo')
    conversation.restore([
      { role: 'system', content: 'STALE prompt for /old-repo' },
      { role: 'user', content: 'hi' },
    ])

    expect(conversation.toArray()).toEqual([
      { role: 'system', content: 'CURRENT prompt for /repo' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('reports empty when only the system prompt is present', () => {
    const conversation = new Conversation('sys')
    expect(conversation.isEmpty()).toBe(true)

    conversation.addUserMessage('hi')
    expect(conversation.isEmpty()).toBe(false)
  })

  it('reset returns to a fresh task without losing the system prompt', () => {
    const conversation = new Conversation('sys')
    conversation.addUserMessage('hi')
    conversation.reset()

    expect(conversation.toArray()).toEqual([{ role: 'system', content: 'sys' }])
    expect(conversation.isEmpty()).toBe(true)
  })

  it('works with no system prompt at all', () => {
    const conversation = new Conversation()
    conversation.restore([{ role: 'user', content: 'hi' }])
    expect(conversation.toArray()).toEqual([{ role: 'user', content: 'hi' }])
  })
})
