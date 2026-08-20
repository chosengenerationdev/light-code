import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChatMessage, ChatProvider, StreamChunk, ToolCall } from '../providers/types.js'
import { PathDenylist } from '../fs/denylist.js'
import { ToolRegistry, type Tool, type ToolExecutionContext, type ToolResult } from '../tools/index.js'
import { runAgentTurn, type AgentTurnEvents } from './loop.js'
import { Conversation } from './messages.js'

/** Yields a different scripted sequence of chunks on each successive call to streamChat. */
class ScriptedMultiTurnProvider implements ChatProvider {
  private callIndex = 0
  public receivedMessages: ChatMessage[][] = []

  constructor(private readonly turns: StreamChunk[][]) {}

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    this.receivedMessages.push(messages)
    const chunks = this.turns[this.callIndex] ?? []
    this.callIndex += 1
    for (const chunk of chunks) yield chunk
  }
}

function fakeToolExecutionContext(): ToolExecutionContext {
  return {
    fs: {} as ToolExecutionContext['fs'],
    terminal: {} as ToolExecutionContext['terminal'],
    workspaceRoot: '/workspace',
    denylist: new PathDenylist(),
    readFiles: new Set(),
  }
}

function fakeTool(name: string, execute: () => Promise<ToolResult>): Tool {
  return {
    name,
    group: 'always',
    description: 'test tool',
    parametersSchema: z.object({}).loose(),
    execute,
  }
}

interface EventLog {
  text: string[]
  toolCall: ToolCall[]
  toolResult: { call: ToolCall; result: ToolResult }[]
  done: true[]
  error: string[]
  nudged: true[]
}

function collectEvents(): { events: AgentTurnEvents; log: EventLog } {
  const log: EventLog = { text: [], toolCall: [], toolResult: [], done: [], error: [], nudged: [] }
  const events: AgentTurnEvents = {
    onTextChunk: (text) => log.text.push(text),
    onToolCall: (call) => log.toolCall.push(call),
    onToolResult: (call, result) => log.toolResult.push({ call, result }),
    onDone: () => log.done.push(true),
    onError: (message) => log.error.push(message),
    onNudgedToContinue: () => log.nudged.push(true),
  }
  return { events, log }
}

describe('runAgentTurn — plain text (no tool call)', () => {
  it('streams text, appends the assistant turn, and calls onDone', async () => {
    const provider = new ScriptedMultiTurnProvider([[{ type: 'text', text: 'Hello' }, { type: 'done' }]])
    const conversation = new Conversation()
    const registry = new ToolRegistry()
    const { events, log } = collectEvents()

    await runAgentTurn(provider, conversation, 'hi', registry, fakeToolExecutionContext(), events)

    expect(log.text).toEqual(['Hello'])
    expect(log.done).toEqual([true])
    expect(log.error).toEqual([])
    expect(conversation.toArray()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
    ])
  })

  it('surfaces an empty response as an error', async () => {
    const provider = new ScriptedMultiTurnProvider([[{ type: 'done' }]])
    const registry = new ToolRegistry()
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'hi', registry, fakeToolExecutionContext(), events)

    expect(log.error).toHaveLength(1)
    expect(log.done).toEqual([])
  })
})

describe('runAgentTurn — tool calls', () => {
  it('executes a tool, feeds the result back, and continues to a final text answer', async () => {
    const provider = new ScriptedMultiTurnProvider([
      [{ type: 'toolCall', toolCall: { id: 'call_1', name: 'echo', arguments: '{}' } }, { type: 'done' }],
      [{ type: 'text', text: 'All done.' }, { type: 'done' }],
    ])
    const registry = new ToolRegistry()
    registry.register(fakeTool('echo', async () => ({ content: 'echoed' })))
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'run echo', registry, fakeToolExecutionContext(), events)

    expect(log.toolResult).toEqual([{ call: { id: 'call_1', name: 'echo', arguments: '{}' }, result: { content: 'echoed' } }])
    expect(log.text).toEqual(['All done.'])
    expect(log.done).toEqual([true])
    // The second provider call must have seen the tool result as conversation history.
    expect(provider.receivedMessages[1]).toContainEqual({ role: 'tool', toolCallId: 'call_1', content: 'echoed' })
  })

  it('stops the loop when attempt_completion is called', async () => {
    const provider = new ScriptedMultiTurnProvider([
      [{ type: 'toolCall', toolCall: { id: 'call_1', name: 'attempt_completion', arguments: '{"result":"done"}' } }, { type: 'done' }],
    ])
    const registry = new ToolRegistry()
    registry.register(fakeTool('attempt_completion', async () => ({ content: 'done' })))
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'do the task', registry, fakeToolExecutionContext(), events)

    expect(log.done).toEqual([true])
    expect(provider.receivedMessages).toHaveLength(1) // never asked the model for another turn
  })

  it('stops the loop when ask_followup_question is called', async () => {
    const provider = new ScriptedMultiTurnProvider([
      [{ type: 'toolCall', toolCall: { id: 'call_1', name: 'ask_followup_question', arguments: '{"question":"which file?"}' } }, { type: 'done' }],
    ])
    const registry = new ToolRegistry()
    registry.register(fakeTool('ask_followup_question', async () => ({ content: 'which file?' })))
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'edit the file', registry, fakeToolExecutionContext(), events)

    expect(log.done).toEqual([true])
    expect(provider.receivedMessages).toHaveLength(1)
  })

  it('reports an unknown tool name without crashing and continues the loop', async () => {
    const provider = new ScriptedMultiTurnProvider([
      [{ type: 'toolCall', toolCall: { id: 'call_1', name: 'does_not_exist', arguments: '{}' } }, { type: 'done' }],
      [{ type: 'text', text: 'recovered' }, { type: 'done' }],
    ])
    const registry = new ToolRegistry()
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'hi', registry, fakeToolExecutionContext(), events)

    expect(log.toolResult[0]?.result.isError).toBe(true)
    expect(log.text).toEqual(['recovered'])
  })
})

describe('runAgentTurn — iteration cap', () => {
  it('stops with a clear message after the configured number of steps', async () => {
    const turn: StreamChunk[] = [{ type: 'toolCall', toolCall: { id: 'call', name: 'loopy', arguments: '{}' } }, { type: 'done' }]
    const provider = new ScriptedMultiTurnProvider(Array.from({ length: 10 }, () => turn))
    const registry = new ToolRegistry()
    registry.register(fakeTool('loopy', async () => ({ content: 'ok' }))) // succeeds every time, no path — never trips mistake tracking
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'go', registry, fakeToolExecutionContext(), events, { maxIterations: 3 })

    expect(provider.receivedMessages).toHaveLength(3)
    expect(log.error).toHaveLength(1)
    expect(log.error[0]).toMatch(/after 3 steps/)
  })
})

describe('runAgentTurn — consecutive-mistake tracking', () => {
  it('stops after N consecutive failures on the same file, before the iteration cap', async () => {
    const turn: StreamChunk[] = [{ type: 'toolCall', toolCall: { id: 'call', name: 'flaky', arguments: '{}' } }, { type: 'done' }]
    const provider = new ScriptedMultiTurnProvider(Array.from({ length: 10 }, () => turn))
    const registry = new ToolRegistry()
    registry.register(fakeTool('flaky', async () => ({ content: 'nope', isError: true, path: 'a.ts' })))
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'edit a.ts', registry, fakeToolExecutionContext(), events, { maxIterations: 25 })

    expect(provider.receivedMessages).toHaveLength(3) // stopped well before the 25-step cap
    expect(log.error).toHaveLength(1)
    expect(log.error[0]).toContain('3 consecutive failed attempts on "a.ts"')
  })

  it('resets the count after a success on that file', async () => {
    // fail, fail, SUCCESS (resets), fail, fail — five failures total but never three
    // consecutively, so the loop must keep going rather than trip the mistake limit.
    const failure: ToolResult = { content: 'nope', isError: true, path: 'a.ts' }
    const success: ToolResult = { content: 'fixed', path: 'a.ts' }
    const scripted: ToolResult[] = [failure, failure, success, failure, failure]
    let call = 0

    const turn: StreamChunk[] = [{ type: 'toolCall', toolCall: { id: 'call', name: 'flaky', arguments: '{}' } }, { type: 'done' }]
    const provider = new ScriptedMultiTurnProvider(Array.from({ length: 20 }, () => turn))
    const registry = new ToolRegistry()
    registry.register(
      fakeTool('flaky', async () => {
        const result = scripted[call] ?? success // keep succeeding once the script runs out
        call += 1
        return result
      }),
    )
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'edit a.ts', registry, fakeToolExecutionContext(), events, { maxIterations: 8 })

    // Ran to the iteration cap rather than stopping early on consecutive mistakes.
    expect(provider.receivedMessages).toHaveLength(8)
    expect(log.error[0]).toMatch(/after 8 steps/)
  })
})

describe('runAgentTurn — late errors preserve partial text', () => {
  it('keeps text already streamed before a mid-stream error', async () => {
    const provider = new ScriptedMultiTurnProvider([[{ type: 'text', text: 'partial' }, { type: 'error', error: 'connection dropped' }]])
    const conversation = new Conversation()
    const registry = new ToolRegistry()
    const { events, log } = collectEvents()

    await runAgentTurn(provider, conversation, 'hi', registry, fakeToolExecutionContext(), events)

    expect(log.error).toEqual(['connection dropped'])
    expect(conversation.toArray()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'partial' },
    ])
  })
})

/**
 * The reported failure, end to end: "I'll create a dummy skill... Let me make something
 * generic but realistic." and then nothing happened. The heuristic being right is worth
 * nothing unless the loop acts on it, which is what these cover.
 */
describe('runAgentTurn — the model announces an action and calls nothing', () => {
  it('asks it to continue, and the tool then runs', async () => {
    const provider = new ScriptedMultiTurnProvider([
      [{ type: 'text', text: "I'll create the skill. Let me make something realistic." }, { type: 'done' }],
      [{ type: 'toolCall', toolCall: { id: '1', name: 'write_skill', arguments: '{}' } }, { type: 'done' }],
      [{ type: 'text', text: 'Created it.' }, { type: 'done' }],
    ])
    const registry = new ToolRegistry()
    registry.register(fakeTool('write_skill', async () => ({ content: 'written' })))
    const conversation = new Conversation()
    const { events, log } = collectEvents()

    await runAgentTurn(provider, conversation, 'create a skill', registry, fakeToolExecutionContext(), events)

    expect(log.nudged).toEqual([true])
    expect(log.toolCall.map((call) => call.name)).toEqual(['write_skill'])
    expect(log.done).toEqual([true])
    // The announcement is kept: it is what the model actually said, and deleting it would make
    // the restored transcript disagree with what the user watched happen.
    expect(conversation.toArray()[1]).toMatchObject({ role: 'assistant' })
  })

  /** A chatty model must not be talked round forever — one nudge, then the turn ends. */
  it('nudges at most once, however many times it narrates', async () => {
    const narration: StreamChunk[] = [{ type: 'text', text: 'Let me look into that.' }, { type: 'done' }]
    const provider = new ScriptedMultiTurnProvider([narration, narration, narration, narration])
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'go', new ToolRegistry(), fakeToolExecutionContext(), events)

    expect(log.nudged).toEqual([true])
    expect(log.done).toEqual([true])
    // Two requests: the original and the one after the nudge. Not four.
    expect(provider.receivedMessages).toHaveLength(2)
  })

  /** The behaviour every release so far has had, and the common case. It must not change. */
  it('leaves an ordinary answer alone, spending no extra request', async () => {
    const provider = new ScriptedMultiTurnProvider([
      [{ type: 'text', text: 'There are three profiles configured.' }, { type: 'done' }],
    ])
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'how many?', new ToolRegistry(), fakeToolExecutionContext(), events)

    expect(log.nudged).toEqual([])
    expect(log.done).toEqual([true])
    expect(provider.receivedMessages).toHaveLength(1)
  })

  it('still reports an empty response as an error rather than nudging it', async () => {
    const provider = new ScriptedMultiTurnProvider([[{ type: 'done' }]])
    const { events, log } = collectEvents()

    await runAgentTurn(provider, new Conversation(), 'hi', new ToolRegistry(), fakeToolExecutionContext(), events)

    expect(log.nudged).toEqual([])
    expect(log.error).toHaveLength(1)
  })
})
