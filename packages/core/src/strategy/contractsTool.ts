import { z } from 'zod'

import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import type { Strategy, StrategyEdge } from './strategy.js'

/**
 * The main agent proposing what passes between two steps of the strategy - asked for together with checked
 * contracts: connectors the user left without a contract get one the agent writes when it plans, and the user approves
 * it. `edit` group, in `ALWAYS_ASK_TOOLS` (the approval shows every change) and `NEVER_AVAILABLE_TO_SCHEDULES` (a run
 * rewriting the contracts it is checked against would be bound by nothing - the plan's reasoning, §12h).
 *
 * It changes this chat's copy of the strategy only; saving it to the library is the user's, in the window.
 */

const item = z.object({
  from: z.string().min(1).describe('The role that hands over, e.g. "programmer".'),
  to: z.string().min(1).describe('The role that receives it, e.g. "tester".'),
  contract: z.string().max(1000).optional().describe('What passes along this connector, in a sentence.'),
  requires: z.array(z.string().trim().min(1).max(80)).max(10).optional().describe('The items the hand-over must contain, each a short name ("Changed files", "Tests run"). Light Code checks every one.'),
})

const schema = z.object({
  contracts: z.array(item).min(1).max(20).describe('One entry per connector to set. A connector is named by the two roles it joins.'),
})

export type SetStrategyContractsParams = z.infer<typeof schema>

/** The connector joining `from` and `to` - in that direction, or either for a back-and-forth. */
function findEdge(strategy: Strategy, from: string, to: string): StrategyEdge | undefined {
  const roleOf = (id: string): string | undefined => strategy.nodes.find((n) => n.id === id)?.role
  return (
    strategy.edges.find((e) => roleOf(e.from) === from && roleOf(e.to) === to) ??
    strategy.edges.find((e) => e.twoWay === true && roleOf(e.from) === to && roleOf(e.to) === from)
  )
}

/** The strategy with the contracts applied, and what changed or could not be found, in words. */
export function applyContracts(strategy: Strategy, params: SetStrategyContractsParams, roleName: (role: string) => string): { strategy: Strategy; lines: string[]; unknown: string[] } {
  const lines: string[] = []
  const unknown: string[] = []
  let edges = strategy.edges
  for (const entry of params.contracts) {
    const from = entry.from.trim().toLowerCase()
    const to = entry.to.trim().toLowerCase()
    const edge = findEdge({ ...strategy, edges }, from, to)
    if (edge === undefined) {
      unknown.push(`${roleName(from)} → ${roleName(to)}`)
      continue
    }
    const next: StrategyEdge = {
      ...edge,
      ...(entry.contract !== undefined ? { contract: entry.contract.trim() } : {}),
      ...(entry.requires !== undefined ? { requires: entry.requires.map((r) => r.trim()).filter((r) => r.length > 0) } : {}),
    }
    edges = edges.map((e) => (e.id === edge.id ? next : e))
    lines.push(
      `${roleName(from)} → ${roleName(to)}:`,
      `  contract: ${edge.contract ?? '(none)'}  →  ${next.contract ?? '(none)'}`,
      `  required: ${(edge.requires ?? []).join(', ') || '(none)'}  →  ${(next.requires ?? []).join(', ') || '(none)'}`,
    )
  }
  return { strategy: { ...strategy, edges, updatedAt: Date.now() }, lines, unknown }
}

export function createSetStrategyContractsTool(deps: {
  current: () => Strategy | undefined
  apply: (next: Strategy) => Promise<void>
  roleName: (role: string) => string
}): Tool<SetStrategyContractsParams> {
  return {
    name: 'set_strategy_contracts',
    group: 'edit',
    description:
      "Propose what passes between steps of this chat's strategy: a contract and the items each hand-over must contain, " +
      'for connectors that have none (or to sharpen one). The user approves the change; Light Code then checks every required ' +
      'item after each answer and asks the specialist again for what is missing.',
    parametersSchema: schema,
    async preview(params): Promise<ToolPreview> {
      const strategy = deps.current()
      if (strategy === undefined) return { kind: 'text', text: 'No strategy is in use in this chat, so there is nothing to change.' }
      const { lines, unknown } = applyContracts(strategy, params, deps.roleName)
      return {
        kind: 'text',
        text: [
          `Change the contracts of the strategy "${strategy.name}" in this chat:`,
          '',
          ...lines,
          ...(unknown.length > 0 ? ['', `Not in the strategy, so left alone: ${unknown.join(', ')}`] : []),
          '',
          'Only this chat is changed; save it in the Strategy window to keep it in your library.',
        ].join('\n'),
      }
    },
    async execute(params): Promise<ToolResult> {
      const strategy = deps.current()
      if (strategy === undefined) return { content: 'No strategy is in use in this chat.', isError: true }
      const { strategy: next, lines, unknown } = applyContracts(strategy, params, deps.roleName)
      if (lines.length === 0) return { content: `None of those connectors are in the strategy: ${unknown.join(', ')}.`, isError: true }
      await deps.apply(next)
      return {
        content:
          `Contracts set. Light Code now checks the required items after each hand-over.\n${lines.join('\n')}` +
          (unknown.length > 0 ? `\nNot in the strategy, so left alone: ${unknown.join(', ')}` : ''),
      }
    },
  }
}
