import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import type { ChatProvider, StreamChunk } from '../providers/types.js'
import type { Tool, ToolExecutionContext } from '../tools/types.js'
import { runConsultation, toolsForConsultation } from './consult.js'

/** A provider that replays scripted turns, so the loop's decisions are what is under test. */
function scripted(turns: StreamChunk[][]): { provider: ChatProvider; toolsSeen: boolean[] } {
  const toolsSeen: boolean[] = []
  let turn = 0
  return {
    toolsSeen,
    provider: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamChat(_messages, options) {
        toolsSeen.push((options?.tools?.length ?? 0) > 0)
        const chunks = turns[Math.min(turn, turns.length - 1)] ?? [{ type: 'text', text: '' }]
        turn += 1
        for (const chunk of chunks) yield chunk
      },
    },
  }
}

function tool(name: string, group: string, run?: () => Promise<{ content: string }>): Tool {
  return {
    name,
    group,
    description: `${name} does a thing`,
    parametersSchema: z.object({}).passthrough(),
    execute: run ?? (async () => ({ content: `${name} ran` })),
  } as unknown as Tool
}

const context = {} as ToolExecutionContext

function call(name: string): StreamChunk {
  return { type: 'toolCall', toolCall: { id: `c-${name}`, name, arguments: '{}' } }
}

describe('what a specialist may use', () => {
  /**
   * Filtered by group, never by a list of names.
   *
   * A read tool added later is then available without anybody remembering — and, the half that
   * matters, a tool added to a *different* group never becomes available by being forgotten here.
   */
  it('offers read tools and nothing that can change anything', () => {
    const offered = toolsForConsultation([
      tool('read_file', 'read'),
      tool('search_files', 'read'),
      tool('write_to_file', 'edit'),
      tool('execute_command', 'command'),
      tool('filesystem__write', 'mcp'),
    ])
    expect(offered.map((t) => t.name)).toEqual(['read_file', 'search_files'])
  })

  /** Letting a specialist consult a specialist is a loop with a bill attached. */
  it('never offers the consultation tools back to it', () => {
    const offered = toolsForConsultation([tool('ask_agent', 'read'), tool('ask_expert', 'read')])
    expect(offered).toEqual([])
  })
})

describe('a consultation that looks things up', () => {
  it('answers directly when it needs nothing', async () => {
    const { provider } = scripted([[{ type: 'text', text: 'Here is the answer.' }]])
    const result = await runConsultation({
      provider,
      prompt: 'why',
      tools: [],
      definitions: [],
      context,
    })
    expect(result).toEqual({ advice: 'Here is the answer.', steps: 0, truncated: false })
  })

  it('runs a lookup and uses what came back', async () => {
    const { provider } = scripted([
      [call('read_file')],
      [{ type: 'text', text: 'Having read it, the retry is wrong.' }],
    ])
    const seen: string[] = []
    const result = await runConsultation({
      provider,
      prompt: 'review this',
      tools: [tool('read_file', 'read')],
      definitions: [{ name: 'read_file', description: 'd', parameters: {} }] as never,
      context,
      onStep: (name) => seen.push(name),
    })
    expect(result.advice).toContain('the retry is wrong')
    expect(result.steps).toBe(1)
    expect(seen).toEqual(['read_file'])
  })

  /**
   * The cap withdraws the tools rather than asking politely.
   *
   * A model asked to stop looking things up will sometimes look one more thing up, and then there
   * is no turn left to answer in. Removing them makes answering the only available move.
   */
  it('stops offering tools on the final pass', async () => {
    const { provider, toolsSeen } = scripted([
      [call('read_file')],
      [call('read_file')],
      [{ type: 'text', text: 'Answering with what I have.' }],
    ])
    const result = await runConsultation({
      provider,
      prompt: 'x',
      tools: [tool('read_file', 'read')],
      definitions: [{ name: 'read_file', description: 'd', parameters: {} }] as never,
      context,
      maxSteps: 2,
    })
    expect(result.steps).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.advice).toContain('Answering with what I have')
    // Offered, offered, withdrawn.
    expect(toolsSeen).toEqual([true, true, false])
  })

  /**
   * A failed lookup is information, not the end.
   *
   * "That file is not there" is frequently the thing the specialist most needed to know, and
   * ending the consultation would throw that away along with the round trip.
   */
  it('hands a failure back and carries on', async () => {
    const failing = tool('read_file', 'read', () => Promise.reject(new Error('no such file')))
    const { provider } = scripted([
      [call('read_file')],
      [{ type: 'text', text: 'That file does not exist, which is itself the bug.' }],
    ])
    const result = await runConsultation({
      provider,
      prompt: 'x',
      tools: [failing],
      definitions: [{ name: 'read_file', description: 'd', parameters: {} }] as never,
      context,
    })
    expect(result.advice).toContain('which is itself the bug')
  })

  /** Reaching for something it does not have is a misjudgement, not a failure to end on. */
  it('tells it what it does have when it reaches for something else', async () => {
    const { provider } = scripted([
      [call('execute_command')],
      [{ type: 'text', text: 'Understood, recommending instead.' }],
    ])
    const result = await runConsultation({
      provider,
      prompt: 'x',
      tools: [tool('read_file', 'read')],
      definitions: [{ name: 'read_file', description: 'd', parameters: {} }] as never,
      context,
    })
    expect(result.advice).toContain('recommending instead')
  })

  it('offers nothing at all when there is nothing to read with', async () => {
    const { provider, toolsSeen } = scripted([[{ type: 'text', text: 'From the question alone.' }]])
    await runConsultation({ provider, prompt: 'x', tools: [], definitions: [], context })
    expect(toolsSeen).toEqual([false])
  })
})
