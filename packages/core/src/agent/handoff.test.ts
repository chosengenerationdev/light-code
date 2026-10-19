import { describe, expect, it } from 'vitest'
import { composeHandoff, handoffFacts, handoffTranscript } from './handoff.js'
import { CONTINUE_PROMPT } from './unfinished.js'
import type { ChatMessage } from '../providers/types.js'

/**
 * A new chat from a handoff of this one. The facts are read from the conversation itself, never from the
 * model's memory of it - a summary is exactly where a file name or a requirement goes missing.
 */

const call = (id: string, name: string, args: object) => ({ id, name, arguments: JSON.stringify(args) })

const conversation: ChatMessage[] = [
  { role: 'system', content: 'You are Light Code.' },
  { role: 'user', content: 'Fix the rounding in invoice totals. Keep two decimals.' },
  { role: 'assistant', content: '', toolCalls: [call('1', 'read_file', { path: 'src/invoice.ts' })] },
  { role: 'tool', toolCallId: '1', content: 'x'.repeat(5000) },
  { role: 'assistant', content: '', toolCalls: [call('2', 'apply_diff', { path: 'src/invoice.ts', diff: '...' })] },
  { role: 'tool', toolCallId: '2', content: 'ok' },
  { role: 'user', content: CONTINUE_PROMPT },
  { role: 'assistant', content: '', toolCalls: [call('3', 'execute_command', { command: 'npm test' })] },
  { role: 'tool', toolCallId: '3', content: 'passed' },
  { role: 'assistant', content: '', toolCalls: [call('4', 'call_tool', { name: 'read_many_files', arguments: { files: [{ path: 'src/tax.ts' }, { path: 'src/invoice.ts' }] } })] },
  { role: 'user', content: 'Also do credit notes.' },
]

describe('the handoff facts', () => {
  it('takes every message the user typed, verbatim, and leaves out the loop\'s own nudge', () => {
    expect(handoffFacts(conversation).userMessages).toEqual(['Fix the rounding in invoice totals. Keep two decimals.', 'Also do credit notes.'])
  })

  it('lists files read and changed, and commands run, from the real tool calls - including through call_tool', () => {
    const facts = handoffFacts(conversation)
    expect(facts.filesRead).toEqual(['src/invoice.ts', 'src/tax.ts'])
    expect(facts.filesChanged).toEqual(['src/invoice.ts'])
    expect(facts.commands).toEqual(['npm test'])
  })
})

describe('the transcript the model reads', () => {
  it('shortens long tool output and leaves out the system prompt', () => {
    const text = handoffTranscript(conversation, 100_000)
    expect(text).not.toContain('You are Light Code')
    expect(text).toContain('more characters')
    expect(text.length).toBeLessThan(6000)
  })

  it('keeps the start and the end when it must cut, and says so', () => {
    const text = handoffTranscript(conversation, 600)
    expect(text).toContain('Fix the rounding')
    expect(text).toContain('credit notes')
    expect(text).toContain('cut here to fit')
  })
})

describe('the first message of the new chat', () => {
  it('carries the note, the user\'s words and the facts', () => {
    const message = composeHandoff('## Goal\nCorrect rounding.', handoffFacts(conversation), 'Fix the rounding')
    expect(message.startsWith('# Handoff: Fix the rounding')).toBe(true)
    expect(message).toContain('## Goal\nCorrect rounding.')
    expect(message).toContain('> Fix the rounding in invoice totals. Keep two decimals.')
    expect(message).toContain('## Files changed\n- `src/invoice.ts`')
    expect(message).toContain('## Commands run\n- `npm test`')
  })

  it('keeps the newest requests when they do not all fit', () => {
    const many = Array.from({ length: 40 }, (_, index) => `request ${String(index)} ${'y'.repeat(1000)}`)
    const message = composeHandoff('note', { userMessages: many, filesRead: [], filesChanged: [], commands: [] }, undefined)
    expect(message).toContain('request 39')
    expect(message).not.toContain('request 0 ')
    expect(message).toMatch(/earlier messages left out/)
  })
})
