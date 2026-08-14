import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '../approval/types.js'
import { PathDenylist } from '../fs/denylist.js'
import { ASK_MODE, CODE_MODE } from '../modes/builtin.js'
import { toolsForMode } from '../modes/resolve.js'
import type { ChatProvider, StreamChunk } from '../providers/types.js'
import { createCallToolTool } from '../tools/callTool.js'
import { toToolDefinitions } from '../tools/registry.js'
import { ToolRegistry, type Tool, type ToolExecutionContext, type ToolGroup, type ToolResult } from '../tools/index.js'
import { runAgentTurn, type AgentTurnEvents } from './loop.js'
import { Conversation } from './messages.js'

class ScriptedProvider implements ChatProvider {
  private callIndex = 0
  public callCount = 0
  constructor(private readonly turns: StreamChunk[][]) {}
  async *streamChat(): AsyncGenerator<StreamChunk> {
    this.callCount += 1
    const chunks = this.turns[this.callIndex] ?? [{ type: 'text', text: 'fallback' }, { type: 'done' }]
    this.callIndex += 1
    for (const chunk of chunks) yield chunk
  }
}

function toolContext(): ToolExecutionContext {
  return {
    fs: {} as ToolExecutionContext['fs'],
    terminal: {} as ToolExecutionContext['terminal'],
    workspaceRoot: '/workspace',
    denylist: new PathDenylist(),
    readFiles: new Set(),
  }
}

function spyTool(name: string, group: ToolGroup): Tool & { ran: boolean; sawParams: unknown } {
  const tool = {
    name,
    group,
    description: `the ${name} tool`,
    parametersSchema: z.object({ target: z.string().optional() }).loose(),
    ran: false,
    sawParams: undefined as unknown,
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      tool.ran = true
      tool.sawParams = params
      return { content: `${name} executed` }
    },
  }
  return tool
}

function recordingEvents(): { events: AgentTurnEvents; results: ToolResult[] } {
  const results: ToolResult[] = []
  return {
    results,
    events: {
      onTextChunk: () => {},
      onToolCall: () => {},
      onToolResult: (_call, result) => results.push(result),
      onDone: () => {},
      onError: () => {},
    },
  }
}

/** A `call_tool` invocation naming `inner`, then a plain answer. */
function dispatchThen(inner: string, args: Record<string, unknown> = {}): StreamChunk[][] {
  return [
    [
      {
        type: 'toolCall',
        toolCall: { id: 'call_1', name: 'call_tool', arguments: JSON.stringify({ name: inner, arguments: args }) },
      },
      { type: 'done' },
    ],
    [{ type: 'text', text: 'finished' }, { type: 'done' }],
  ]
}

class FixedGate implements ApprovalGate {
  public seen: ApprovalRequest[] = []
  constructor(private readonly decision: ApprovalDecision) {}
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(request)
    return this.decision
  }
}

function registryWith(...tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(createCallToolTool())
  for (const tool of tools) registry.register(tool, { dispatchOnly: true })
  return registry
}

describe('dispatch-only registration', () => {
  it('keeps a dispatch-only tool out of the prompt while leaving it callable', () => {
    const hidden = spyTool('s3__get_object', 'read')
    const registry = registryWith(hidden)

    expect(registry.promptList().map((tool) => tool.name)).toEqual(['call_tool'])
    expect(registry.dispatchOnlyList().map((tool) => tool.name)).toEqual(['s3__get_object'])
    // Still fully registered: this is what the loop resolves against.
    expect(registry.get('s3__get_object')).toBe(hidden)
  })

  it('leaves no trace of a hidden tool in the definitions sent to the model', () => {
    const registry = registryWith(spyTool('s3__get_object', 'read'))
    expect(JSON.stringify(registry.toToolDefinitions())).not.toContain('s3__get_object')
  })

  /**
   * The whole reason the dispatcher exists (§12): the prefix must not grow with the tool
   * catalogue, or the prompt cache is invalidated every time a server's tool list changes.
   */
  it('produces byte-identical definitions no matter how many tools are hidden', () => {
    const few = registryWith(spyTool('a__one', 'read'))
    const many = registryWith(...Array.from({ length: 200 }, (_, i) => spyTool(`srv__tool_${i}`, 'read')))

    expect(JSON.stringify(toToolDefinitions(toolsForMode(many, CODE_MODE)))).toBe(
      JSON.stringify(toToolDefinitions(toolsForMode(few, CODE_MODE))),
    )
  })

  it('re-registering without the flag un-hides a tool', () => {
    const registry = new ToolRegistry()
    const tool = spyTool('py__thing', 'command')
    registry.register(tool, { dispatchOnly: true })
    expect(registry.promptList()).toHaveLength(0)

    registry.register(tool)
    expect(registry.promptList().map((entry) => entry.name)).toEqual(['py__thing'])
  })
})

describe('call_tool unwrapping', () => {
  it('runs the named tool and passes its arguments through', async () => {
    const hidden = spyTool('s3__get_object', 'read')
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(dispatchThen('s3__get_object', { target: 'bucket/key' })),
      new Conversation(),
      'fetch it',
      registryWith(hidden),
      toolContext(),
      events,
      { approvalGate: new FixedGate('approve') },
    )

    expect(hidden.ran).toBe(true)
    expect(hidden.sawParams).toMatchObject({ target: 'bucket/key' })
    expect(results[0]?.content).toBe('s3__get_object executed')
  })

  /**
   * **The property this whole design turns on.** The gate must be asked about the tool that
   * will actually run, never about `call_tool` — otherwise approving the dispatcher once, or
   * adding it to "always allow", would be a blanket grant over every hidden tool behind it.
   */
  it('asks the user about the inner tool, never about call_tool', async () => {
    const gate = new FixedGate('approve')
    const { events } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(dispatchThen('s3__delete_object')),
      new Conversation(),
      'delete it',
      registryWith(spyTool('s3__delete_object', 'command')),
      toolContext(),
      events,
      { approvalGate: gate },
    )

    expect(gate.seen).toHaveLength(1)
    expect(gate.seen[0]?.toolName).toBe('s3__delete_object')
    // The group drives the auto-approve category, so a read-group dispatcher wrapping a
    // command-group tool would be a real escalation.
    expect(gate.seen[0]?.group).toBe('command')
  })

  it('does not execute a dispatched tool the user denied', async () => {
    const hidden = spyTool('s3__delete_object', 'command')
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(dispatchThen('s3__delete_object')),
      new Conversation(),
      'delete it',
      registryWith(hidden),
      toolContext(),
      events,
      { approvalGate: new FixedGate('deny') },
    )

    expect(hidden.ran).toBe(false)
    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.content).toMatch(/denied permission/i)
  })

  /**
   * Dispatch must not be a way around a mode. Ask mode excludes the `edit` group, and it has
   * to keep excluding it when the call arrives wrapped.
   */
  it('enforces the active mode against the inner tool', async () => {
    const hidden = spyTool('srv__write_thing', 'edit')
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(dispatchThen('srv__write_thing')),
      new Conversation(),
      'write it',
      registryWith(hidden),
      toolContext(),
      events,
      { mode: ASK_MODE, approvalGate: new FixedGate('approve') },
    )

    expect(hidden.ran).toBe(false)
    expect(results[0]?.content).toMatch(/not available in Ask mode/i)
  })

  it('validates arguments against the inner tool\'s schema', async () => {
    const hidden: Tool = {
      name: 'srv__strict',
      group: 'read',
      description: 'strict',
      parametersSchema: z.object({ count: z.number() }),
      execute: async () => ({ content: 'ran' }),
    }
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(dispatchThen('srv__strict', { count: 'not a number' })),
      new Conversation(),
      'go',
      registryWith(hidden),
      toolContext(),
      events,
      { approvalGate: new FixedGate('approve') },
    )

    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.content).toMatch(/invalid arguments for "srv__strict"/i)
  })

  it('refuses to call itself', async () => {
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(dispatchThen('call_tool')),
      new Conversation(),
      'go',
      registryWith(),
      toolContext(),
      events,
      { approvalGate: new FixedGate('approve') },
    )

    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.content).toMatch(/cannot call itself/i)
  })

  it('points at search_docs when the named tool does not exist', async () => {
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(dispatchThen('srv__typo')),
      new Conversation(),
      'go',
      registryWith(spyTool('srv__real', 'read')),
      toolContext(),
      events,
      { approvalGate: new FixedGate('approve') },
    )

    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.content).toMatch(/search_docs/)
  })

  it('rejects a malformed dispatch rather than guessing', async () => {
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider([
        [{ type: 'toolCall', toolCall: { id: 'call_1', name: 'call_tool', arguments: '{"name":' } }, { type: 'done' }],
        [{ type: 'text', text: 'ok' }, { type: 'done' }],
      ]),
      new Conversation(),
      'go',
      registryWith(),
      toolContext(),
      events,
      { approvalGate: new FixedGate('approve') },
    )

    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.content).toMatch(/malformed JSON/i)
  })

  /**
   * `call_tool.execute` is unreachable by design — the loop unwraps first. If it ever is
   * reached the unwrap has been bypassed, and dispatching from there would skip the gate.
   */
  it('never dispatches from call_tool.execute itself', async () => {
    const result = await createCallToolTool().execute(
      { name: 's3__delete_object', arguments: {} },
      toolContext(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/not resolved to a target tool/i)
  })

  it('leaves an ordinary direct tool call completely unaffected', async () => {
    const plain = spyTool('read_file', 'read')
    const registry = new ToolRegistry()
    registry.register(createCallToolTool())
    registry.register(plain)
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider([
        [{ type: 'toolCall', toolCall: { id: 'call_1', name: 'read_file', arguments: '{}' } }, { type: 'done' }],
        [{ type: 'text', text: 'done' }, { type: 'done' }],
      ]),
      new Conversation(),
      'read it',
      registry,
      toolContext(),
      events,
      { approvalGate: new FixedGate('approve') },
    )

    expect(plain.ran).toBe(true)
    expect(results[0]?.content).toBe('read_file executed')
  })
})
