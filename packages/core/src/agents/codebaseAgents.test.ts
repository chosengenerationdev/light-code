import { describe, expect, it } from 'vitest'
import type { ToolExecutionContext } from '../tools/types.js'
import { answerFromConversation, createAskCodebaseAgentTool, MAX_DEPTH, type CodebaseAgentChannel } from './codebaseAgents.js'

const channel = (asked: unknown[]): CodebaseAgentChannel => ({
  ask: async (codebase, message, options) => {
    asked.push({ codebase, message, depth: options.depth })
    return { ok: true, text: 'Use rates.v2.', chat: 'From payments: rates' }
  },
  onTask: () => undefined,
  done: () => undefined,
})
const context = {} as ToolExecutionContext

describe('ask_codebase_agent', () => {
  it('names the other codebases, shows the literal request, and returns the answer with where it was worked on', async () => {
    const asked: unknown[] = []
    const tool = createAskCodebaseAgentTool({ channel: channel(asked), codebases: [{ name: 'billing' }], depth: () => 0 })
    expect(tool.description).toContain('"billing"')
    const preview = await tool.preview!({ codebase: 'billing', request: 'Which endpoint?' }, context)
    expect(preview).toMatchObject({ kind: 'text', text: expect.stringContaining('Which endpoint?') })
    const result = await tool.execute({ codebase: 'billing', request: 'Which endpoint?' }, context)
    expect(result.content).toBe('The agent in "billing" (its chat "From payments: rates") answered:\n\nUse rates.v2.')
    expect(asked).toEqual([{ codebase: 'billing', message: 'Which endpoint?', depth: 1 }])
  })

  it('stops a chain of agents asking agents', async () => {
    const asked: unknown[] = []
    const tool = createAskCodebaseAgentTool({ channel: channel(asked), codebases: [{ name: 'billing' }], depth: () => MAX_DEPTH })
    const result = await tool.execute({ codebase: 'billing', request: 'x' }, context)
    expect(result.isError).toBe(true)
    expect(asked).toEqual([])
  })
})

describe('the answer sent back', () => {
  it('is the attempt_completion result, or the question it stopped on, or its last words', () => {
    const call = (name: string, args: object) => ({ role: 'assistant' as const, content: '', toolCalls: [{ id: '1', name, arguments: JSON.stringify(args) }] })
    expect(answerFromConversation([{ role: 'user', content: 'q' }, call('attempt_completion', { result: 'Done: v2.' })])).toEqual({ ok: true, text: 'Done: v2.' })
    const asked = answerFromConversation([call('ask_followup_question', { question: 'Which region?' })])
    expect(asked.text).toMatch(/^It stopped to ask the user: Which region\?/)
    // Kept open in Fire Code rather than archived: the conversation goes on there.
    expect(asked.waiting).toBe(true)
    expect(answerFromConversation([call('attempt_completion', { result: 'x' })]).waiting).toBeUndefined()
    expect(answerFromConversation([{ role: 'assistant', content: 'It is v2.' }])).toEqual({ ok: true, text: 'It is v2.' })
    expect(answerFromConversation([{ role: 'user', content: 'q' }]).ok).toBe(false)
  })
})
