import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '../approval/types.js'
import type { Checkpoint, ShadowGit } from '../checkpoints/shadowGit.js'
import { PathDenylist } from '../fs/denylist.js'
import { ASK_MODE, CODE_MODE } from '../modes/builtin.js'
import type { ChatProvider, StreamChunk } from '../providers/types.js'
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

/** Records whether it ran, so "denied" can be distinguished from "ran and failed". */
function spyTool(name: string, group: ToolGroup): Tool & { ran: boolean } {
  const tool = {
    name,
    group,
    description: 'test tool',
    parametersSchema: z.object({}).loose(),
    ran: false,
    async execute(): Promise<ToolResult> {
      tool.ran = true
      return { content: 'executed' }
    },
  }
  return tool
}

function recordingEvents(): { events: AgentTurnEvents; checkpoints: Checkpoint[]; results: ToolResult[] } {
  const checkpoints: Checkpoint[] = []
  const results: ToolResult[] = []
  return {
    checkpoints,
    results,
    events: {
      onTextChunk: () => {},
      onToolCall: () => {},
      onToolResult: (_call, result) => results.push(result),
      onDone: () => {},
      onError: () => {},
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    },
  }
}

function callThen(toolName: string): StreamChunk[][] {
  return [
    [{ type: 'toolCall', toolCall: { id: 'call_1', name: toolName, arguments: '{}' } }, { type: 'done' }],
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

describe('approval gate', () => {
  it('does not execute a tool the user denied', async () => {
    const tool = spyTool('write_to_file', 'edit')
    const registry = new ToolRegistry()
    registry.register(tool)
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('write_to_file')),
      new Conversation(),
      'edit something',
      registry,
      toolContext(),
      events,
      { approvalGate: new FixedGate('deny') },
    )

    expect(tool.ran).toBe(false)
    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.content).toMatch(/denied permission/i)
  })

  it('tells the model about the denial and keeps going rather than aborting the turn', async () => {
    const registry = new ToolRegistry()
    registry.register(spyTool('write_to_file', 'edit'))
    const provider = new ScriptedProvider(callThen('write_to_file'))
    const { events } = recordingEvents()

    await runAgentTurn(provider, new Conversation(), 'edit something', registry, toolContext(), events, {
      approvalGate: new FixedGate('deny'),
    })

    // Asked the model again after the denial — it gets a chance to try something else.
    expect(provider.callCount).toBe(2)
  })

  it('executes when approved', async () => {
    const tool = spyTool('write_to_file', 'edit')
    const registry = new ToolRegistry()
    registry.register(tool)
    const { events } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('write_to_file')),
      new Conversation(),
      'edit something',
      registry,
      toolContext(),
      events,
      { approvalGate: new FixedGate('approve') },
    )

    expect(tool.ran).toBe(true)
  })

  it('never asks approval for control tools, which perform no work', async () => {
    const registry = new ToolRegistry()
    registry.register(spyTool('attempt_completion', 'always'))
    const gate = new FixedGate('deny') // would block it if consulted
    const { events } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('attempt_completion')),
      new Conversation(),
      'finish up',
      registry,
      toolContext(),
      events,
      { approvalGate: gate },
    )

    expect(gate.seen).toHaveLength(0)
  })

  it('asks approval for read tools too — nothing is auto-approved by default', async () => {
    const registry = new ToolRegistry()
    registry.register(spyTool('read_file', 'read'))
    const gate = new FixedGate('approve')
    const { events } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('read_file')),
      new Conversation(),
      'read something',
      registry,
      toolContext(),
      events,
      { approvalGate: gate },
    )

    expect(gate.seen.map((r) => r.toolName)).toEqual(['read_file'])
  })

  it('shows the tool\'s computed preview, not the model\'s arguments, when one exists', async () => {
    const tool: Tool = {
      name: 'apply_diff',
      group: 'edit',
      description: 'test',
      parametersSchema: z.object({}).loose(),
      async execute(): Promise<ToolResult> {
        return { content: 'ok' }
      },
      async preview() {
        return { kind: 'diff', path: 'a.ts', before: 'old', after: 'new' }
      },
    }
    const registry = new ToolRegistry()
    registry.register(tool)
    const gate = new FixedGate('approve')
    const { events } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('apply_diff')),
      new Conversation(),
      'edit',
      registry,
      toolContext(),
      events,
      { approvalGate: gate },
    )

    expect(gate.seen[0]?.preview).toEqual({ kind: 'diff', path: 'a.ts', before: 'old', after: 'new' })
  })

  it('does not treat a failing preview as approval', async () => {
    const tool = {
      ...spyTool('apply_diff', 'edit'),
      async preview(): Promise<never> {
        throw new Error('preview exploded')
      },
    }
    const registry = new ToolRegistry()
    registry.register(tool)
    const gate = new FixedGate('deny')
    const { events } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('apply_diff')),
      new Conversation(),
      'edit',
      registry,
      toolContext(),
      events,
      { approvalGate: gate },
    )

    // Still asked, and still respected the answer.
    expect(gate.seen).toHaveLength(1)
    expect(gate.seen[0]?.preview.kind).toBe('text')
    expect(tool.ran).toBe(false)
  })
})

describe('mode enforcement in the loop', () => {
  it('refuses a tool outside the active mode even if the model calls it anyway', async () => {
    // Simulates a mid-session switch to Ask: the tool is gone from the prompt, but the
    // history still mentions it, so the model may try.
    const tool = spyTool('write_to_file', 'edit')
    const registry = new ToolRegistry()
    registry.register(tool)
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('write_to_file')),
      new Conversation(),
      'edit something',
      registry,
      toolContext(),
      events,
      { mode: ASK_MODE, approvalGate: new FixedGate('approve') },
    )

    expect(tool.ran).toBe(false)
    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.content).toMatch(/not available in Ask mode/i)
  })

  it('allows the same tool in Code mode', async () => {
    const tool = spyTool('write_to_file', 'edit')
    const registry = new ToolRegistry()
    registry.register(tool)
    const { events } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('write_to_file')),
      new Conversation(),
      'edit something',
      registry,
      toolContext(),
      events,
      { mode: CODE_MODE, approvalGate: new FixedGate('approve') },
    )

    expect(tool.ran).toBe(true)
  })
})

describe('checkpoints', () => {
  function fakeShadowGit(): ShadowGit & { snapshots: number } {
    const stub = {
      snapshots: 0,
      async snapshot(): Promise<Checkpoint> {
        stub.snapshots += 1
        return { commit: `commit-${stub.snapshots}`, createdAt: Date.now() }
      },
    }
    return stub as unknown as ShadowGit & { snapshots: number }
  }

  it('snapshots before the first edit', async () => {
    const registry = new ToolRegistry()
    registry.register(spyTool('write_to_file', 'edit'))
    const shadowGit = fakeShadowGit()
    const { events, checkpoints } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('write_to_file')),
      new Conversation(),
      'edit',
      registry,
      toolContext(),
      events,
      { shadowGit },
    )

    expect(shadowGit.snapshots).toBe(1)
    expect(checkpoints[0]?.commit).toBe('commit-1')
  })

  it('snapshots once per task, not once per edit', async () => {
    const registry = new ToolRegistry()
    registry.register(spyTool('write_to_file', 'edit'))
    const shadowGit = fakeShadowGit()
    const { events } = recordingEvents()
    const editTurn: StreamChunk[] = [
      { type: 'toolCall', toolCall: { id: 'c', name: 'write_to_file', arguments: '{}' } },
      { type: 'done' },
    ]

    await runAgentTurn(
      new ScriptedProvider([editTurn, editTurn, editTurn]),
      new Conversation(),
      'edit repeatedly',
      registry,
      toolContext(),
      events,
      { shadowGit, maxIterations: 3 },
    )

    expect(shadowGit.snapshots).toBe(1)
  })

  it('does not snapshot for non-edit tools', async () => {
    const registry = new ToolRegistry()
    registry.register(spyTool('read_file', 'read'))
    const shadowGit = fakeShadowGit()
    const { events } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('read_file')),
      new Conversation(),
      'read',
      registry,
      toolContext(),
      events,
      { shadowGit },
    )

    expect(shadowGit.snapshots).toBe(0)
  })

  it('refuses the edit if the checkpoint could not be created', async () => {
    const tool = spyTool('write_to_file', 'edit')
    const registry = new ToolRegistry()
    registry.register(tool)
    const failing = {
      async snapshot(): Promise<Checkpoint> {
        throw new Error('disk full')
      },
    } as unknown as ShadowGit
    const { events, results } = recordingEvents()

    await runAgentTurn(
      new ScriptedProvider(callThen('write_to_file')),
      new Conversation(),
      'edit',
      registry,
      toolContext(),
      events,
      { shadowGit: failing },
    )

    // Silently editing without a rollback point would be worse than not editing.
    expect(tool.ran).toBe(false)
    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.content).toMatch(/checkpoint/i)
  })
})
