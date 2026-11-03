import { z } from 'zod'

import type { Tool, ToolResult } from '../tools/types.js'
import type { Strategy, StrategyExchange, StrategyProgress } from './strategy.js'

/**
 * What happened under the chat's strategy, for the main agent to explain - asked for: "provide a way for user to
 * see whats happening and why it goes back and forth, at least master agent to explain if user has a question".
 *
 * Read from the exchange log the host records from consultations that ran, so an explanation is of the record and
 * not of the agent's memory of it, which compaction may already have shortened. Read group: it reaches nothing.
 */

const schema = z.object({
  role: z.string().optional().describe('Only exchanges with this role.'),
  last: z.number().int().min(1).max(50).optional().describe('The newest N exchanges (default 20).'),
  full: z.boolean().optional().describe('Questions and answers in full; otherwise the first lines of each.'),
})

export type StrategyHistoryParams = z.infer<typeof schema>

export function createStrategyHistoryTool(deps: {
  current: () => { strategy: Strategy | undefined; progress: StrategyProgress; exchanges: readonly StrategyExchange[] }
  roleName: (role: string) => string
}): Tool<StrategyHistoryParams> {
  return {
    name: 'strategy_history',
    group: 'read',
    description:
      "What happened under this chat's strategy: each specialist consulted, what it was asked and answered, and for every " +
      'back-and-forth its rounds, verdicts and why it went back. Use it to explain the strategy\'s progress when the user asks.',
    parametersSchema: schema,
    async execute(params): Promise<ToolResult> {
      const { strategy, progress, exchanges } = deps.current()
      if (strategy === undefined) return { content: 'No strategy is in use in this chat.' }
      const name = deps.roleName
      const role = params.role?.trim().toLowerCase()
      const chosen = exchanges.filter((e) => role === undefined || e.role === role).slice(-(params.last ?? 20))
      const brief = (text: string): string => (params.full === true ? text : text.split('\n').filter((l) => l.trim().length > 0).slice(0, 3).join(' / ').slice(0, 300))
      const loops = strategy.edges
        .filter((edge) => edge.twoWay === true)
        .map((edge) => {
          const from = strategy.nodes.find((n) => n.id === edge.from)
          const to = strategy.nodes.find((n) => n.id === edge.to)
          const state = progress[edge.id]
          return `- ${name(from?.role ?? '?')} ⇄ ${name(to?.role ?? '?')}: round ${String(state?.rounds ?? 0)} of ${String(edge.maxRounds ?? 10)}${state?.met === true ? ', condition met' : state?.verdict !== undefined ? `, ${state.verdict}` : ''}${edge.until !== undefined ? ` (until "${edge.until}")` : ''}`
        })
      const lines = [`Strategy "${strategy.name}": ${String(exchanges.length)} consultation(s) so far.`]
      if (loops.length > 0) lines.push('', 'Back-and-forth:', ...loops)
      lines.push('', chosen.length > 0 ? 'Exchanges, oldest first:' : 'No exchanges match.')
      for (const e of chosen) {
        lines.push(
          '',
          `[${new Date(e.at).toLocaleTimeString()}] ${name(e.role)}${e.parallel === true ? ' (in parallel)' : ''}${e.refused !== undefined ? ' - REFUSED' : ''}`,
          `  asked: ${brief(e.question)}`,
          e.refused !== undefined ? `  why: ${e.refused}` : `  answered: ${brief(e.answer)}`,
          ...(e.loops ?? []).map((loop) => `  loop: round ${String(loop.rounds)}${loop.met === true ? ', met' : loop.verdict !== undefined ? `, ${loop.verdict}` : ''}`),
        )
      }
      return { content: lines.join('\n') }
    },
  }
}
