import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChatMessage, ChatProvider, StreamChunk } from '../providers/types.js'
import { PathDenylist } from '../fs/denylist.js'
import { ToolRegistry, type Tool, type ToolExecutionContext, type ToolResult } from '../tools/index.js'
import { runAgentTurn, type AgentTurnEvents } from './loop.js'
import { Conversation } from './messages.js'

/**
 * The step cap counts work done **unattended**.
 *
 * It exists to stop a model looping on something it cannot get right while nobody is watching.
 * Somebody typing mid-turn is direct evidence that this is not that situation — they are watching,
 * and they have just changed what the work is. Charging the new instruction for the steps spent
 * before it was given counts the wrong thing.
 *
 * Requested in those terms: the count should reset when there is a user interaction in between.
 */

/** Repeats its last scripted turn for ever, so a test can count how many the loop allowed. */
class ScriptedProvider implements ChatProvider {
  private callIndex = 0
  public calls = 0

  constructor(private readonly turns: StreamChunk[][]) {}

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    void messages
    this.calls += 1
    const turn = this.turns[Math.min(this.callIndex, this.turns.length - 1)] ?? []
    this.callIndex += 1
    for (const chunk of turn) yield chunk
  }
}

const fakeTool = (name: string, run: () => Promise<ToolResult>): Tool => ({
  name,
  group: 'always',
  description: 'test tool',
  parametersSchema: z.object({}).loose(),
  execute: run,
})

const context = (): ToolExecutionContext => ({
  fs: {} as ToolExecutionContext['fs'],
  terminal: {} as ToolExecutionContext['terminal'],
  workspaceRoot: '/workspace',
  denylist: new PathDenylist(),
  readFiles: new Set(),
})

const collect = (): { events: AgentTurnEvents; errors: string[] } => {
  const errors: string[] = []
  const events = {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: (message: string) => errors.push(message),
    onDone: () => {},
  } as unknown as AgentTurnEvents
  return { events, errors }
}

const callTool = (name: string): StreamChunk[] => [
  { type: 'toolCall', toolCall: { id: `c${Math.random()}`, name, arguments: '{}' } },
  { type: 'done' },
]

describe('a message typed while the turn is running', () => {
  it('gives the turn its full budget back', async () => {
    const provider = new ScriptedProvider([callTool('work')])
    const registry = new ToolRegistry()
    registry.register(fakeTool('work', async () => ({ content: 'ok' })))
    const { events, errors } = collect()

    // One message, delivered on the second step. Without the reset the turn would stop after 3
    // provider calls; with it, the budget restarts and 3 more are allowed.
    // Entries rather than bare strings: a queued message can carry images.
    let remaining = [{ text: 'actually, do this instead' }]
    let step = 0
    await runAgentTurn(provider, new Conversation(), 'go', registry, context(), events, {
      maxIterations: 3,
      drainQueuedMessages: () => {
        step += 1
        if (step === 2) {
          const out = remaining
          remaining = []
          return out
        }
        return []
      },
    })

    expect(provider.calls).toBe(5)
    expect(errors[0]).toMatch(/after 3 steps/)
  })

  /* No message means nothing changes — the cap is still the cap. */
  it('leaves the budget alone when nothing was typed', async () => {
    const provider = new ScriptedProvider([callTool('work')])
    const registry = new ToolRegistry()
    registry.register(fakeTool('work', async () => ({ content: 'ok' })))
    const { events } = collect()

    await runAgentTurn(provider, new Conversation(), 'go', registry, context(), events, {
      maxIterations: 3,
      drainQueuedMessages: () => [],
    })

    expect(provider.calls).toBe(3)
  })
})

describe('a form the user filled in', () => {
  it('gives the budget back, like a typed message', async () => {
    const provider = new ScriptedProvider([callTool('ask_user_form')])
    const registry = new ToolRegistry()
    registry.register(fakeTool('ask_user_form', async () => ({ content: 'name: ana' })))
    const { events } = collect()

    await runAgentTurn(provider, new Conversation(), 'go', registry, context(), events, {
      maxIterations: 2,
    })

    /*
     * Five resets, then the cap applies again: one call per reset while the allowance is being
     * handed back, then the final two-step budget runs out. Seven in total.
     *
     * Bounded because the *model* chooses when to ask. Unbounded, it could hold a turn open
     * indefinitely by asking a question whenever it ran low.
     */
    expect(provider.calls).toBe(7)
  })

  /*
   * A dismissal is not an answer. Treating it as one would hand a fresh budget to a dialog
   * nobody filled in — the unattended case wearing the costume of the attended one.
   */
  it('does not give the budget back when the form was dismissed', async () => {
    const provider = new ScriptedProvider([callTool('ask_user_form')])
    const registry = new ToolRegistry()
    registry.register(
      fakeTool('ask_user_form', async () => ({
        content: 'The user dismissed the form without answering. Ask in plain text instead, or continue without it.',
      })),
    )
    const { events } = collect()

    await runAgentTurn(provider, new Conversation(), 'go', registry, context(), events, {
      maxIterations: 3,
    })

    expect(provider.calls).toBe(3)
  })
})
