import { z } from 'zod'

/**
 * A strategy: the flow chart the user draws in Agent team mode (the Strategy window) saying how the main agent
 * should use its specialists - which role does what, in which order, and which pairs go back and forth until a
 * condition holds ("until the tester is happy, the programmer keeps changing it"), at most so many times.
 *
 * Asked for together with: each strategy saved and reusable (`strategies` in config, user-scope), one in use per
 * chat (saved with the chat like its plan), the main agent planning so the plan "satisfies the strategy
 * completely", and a role markable read-only.
 *
 * ## What is enforced and what is guided
 *
 * - **Guided**: the order. The strategy goes into the system prompt, and the agent is told to propose a plan that
 *   carries it out step by step before doing anything. A strategy is a way of working, not a state machine; a
 *   question the user asks mid-way must not be refused because it is not the next box.
 * - **Enforced**, from consultations that actually ran (never from what the agent says it did - the same rule as
 *   the plan's role chips): rounds of a back-and-forth are counted here, a round past the maximum is refused, the
 *   judging role is told the condition and asked for a verdict line, and every answer in a loop comes back with
 *   where the loop stands. A read-only role is given no tool that changes anything.
 */

export const strategyNodeSchema = z.object({
  id: z.string().min(1).max(40),
  /** An agent role id - a built-in role or a custom one from Settings → Agents. */
  role: z.string().min(1).max(40),
  x: z.number().finite(),
  y: z.number().finite(),
  /** May not change anything: no edit or command tools, whatever the role is otherwise allowed. */
  readOnly: z.boolean().optional(),
  /**
   * The user's instructions for this specialist at this step ("write the failing test first, then stop"). Sent to
   * it with every question it is asked under this strategy. Absent: the main agent decides what to ask, from its
   * plan - asked for in those words: "if not given, master agent can come with relevant plan according to strategy".
   */
  instructions: z.string().max(4000).optional(),
  /** The parallel box it sits in (`StrategyGroup.id`), set by the window from where it was dropped. */
  group: z.string().max(40).optional(),
})

/**
 * A parallel box: the steps inside are consulted at the same moment (`ask_agents`), each specialist in its own
 * process, and the strategy continues when all of them have answered.
 */
export const strategyGroupSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(80).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().min(60),
  h: z.number().finite().min(40),
})

export const strategyEdgeSchema = z.object({
  id: z.string().min(1).max(40),
  from: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
  /** Back and forth between the two: `from` works, `to` checks, and back to `from` until `until` or `maxRounds`. */
  twoWay: z.boolean().optional(),
  /** Rounds of a back-and-forth (one `from` then one `to`). Absent with `until`: until it holds, at most 10. */
  maxRounds: z.number().int().min(1).max(50).optional(),
  /** The condition that ends a back-and-forth, judged by `to`: "all tests pass and the tester has no concerns". */
  until: z.string().max(300).optional(),
  label: z.string().max(120).optional(),
  /**
   * The contract: what passes along this connector ("the failing tests, each with file:line and the assertion").
   * The sender is told its answer must contain it, the receiver what it will be given - so what was agreed between
   * two specialists is written down rather than left to each model's guess.
   */
  contract: z.string().max(1000).optional(),
})

export const strategySchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  nodes: z.array(strategyNodeSchema).max(30),
  edges: z.array(strategyEdgeSchema).max(80),
  groups: z.array(strategyGroupSchema).max(10).optional(),
  /** Epoch ms. */
  updatedAt: z.number().int().nonnegative(),
})

export type StrategyNode = z.infer<typeof strategyNodeSchema>
export type StrategyEdge = z.infer<typeof strategyEdgeSchema>
export type StrategyGroup = z.infer<typeof strategyGroupSchema>
export type Strategy = z.infer<typeof strategySchema>

/** A back-and-forth with only a condition still stops here: a loop that cannot end is a turn that cannot end. */
export const DEFAULT_LOOP_ROUNDS = 10

export function roundsOf(edge: StrategyEdge): number {
  return edge.maxRounds ?? DEFAULT_LOOP_ROUNDS
}

/** Why a strategy cannot be used, one sentence each, or an empty list. */
export function strategyProblems(strategy: Strategy, knownRoles: ReadonlySet<string>, assigned: ReadonlySet<string>): string[] {
  const problems: string[] = []
  if (strategy.nodes.length === 0) problems.push('It has no steps: add at least one role.')
  const ids = new Set<string>()
  for (const node of strategy.nodes) {
    if (ids.has(node.id)) problems.push(`Two steps share the id ${node.id}.`)
    ids.add(node.id)
    if (!knownRoles.has(node.role)) problems.push(`"${node.role}" is not an agent role any more.`)
    else if (!assigned.has(node.role)) problems.push(`Nobody is assigned to ${node.role}: give it a model in Settings → Agents.`)
  }
  const pairs = new Set<string>()
  for (const edge of strategy.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) problems.push('A connector points at a step that is not there.')
    if (edge.from === edge.to) problems.push('A connector goes from a step to itself.')
    const pair = [edge.from, edge.to].sort().join('|')
    if (edge.twoWay === true && pairs.has(pair)) problems.push('Two back-and-forth connectors join the same two steps.')
    if (edge.twoWay === true) pairs.add(pair)
  }
  for (const group of strategy.groups ?? []) {
    const inside = strategy.nodes.filter((node) => node.group === group.id)
    const roles = inside.map((node) => node.role)
    if (new Set(roles).size !== roles.length) problems.push(`${group.label ?? 'A parallel box'} holds one role twice; one specialist answers one question at a time, so they would not run in parallel.`)
  }
  return [...new Set(problems)]
}

/**
 * The order to read the chart in: steps nobody points to first, then breadth-first along one-way connectors (a
 * back-and-forth counts as going from `from` to `to`), ties by position on the canvas, left to right. Steps a
 * cycle hides are added at the end in canvas order, so every step appears once.
 */
export function strategyOrder(strategy: Strategy): StrategyNode[] {
  const byId = new Map(strategy.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, number>(strategy.nodes.map((node) => [node.id, 0]))
  for (const edge of strategy.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  const canvas = (a: StrategyNode, b: StrategyNode): number => a.x - b.x || a.y - b.y
  const queue = strategy.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).sort(canvas)
  const seen = new Set<string>()
  const out: StrategyNode[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    if (seen.has(node.id)) continue
    seen.add(node.id)
    out.push(node)
    const next = strategy.edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => byId.get(edge.to))
      .filter((n): n is StrategyNode => n !== undefined && !seen.has(n.id))
      .sort(canvas)
    queue.push(...next)
  }
  for (const node of [...strategy.nodes].sort(canvas)) if (!seen.has(node.id)) out.push(node)
  return out
}

function firstLine(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

/** The strategy as the main agent reads it, in its system prompt. */
export function describeStrategy(strategy: Strategy, roleName: (role: string) => string): string {
  const order = strategyOrder(strategy)
  const number = new Map(order.map((node, i) => [node.id, i + 1]))
  const label = (id: string): string => {
    const node = strategy.nodes.find((n) => n.id === id)
    return node === undefined ? id : `${roleName(node.role)} (step ${String(number.get(id) ?? '?')})`
  }
  const lines = [`## Strategy: ${strategy.name}`, '', 'The user drew how this work must be done. Steps, each done by consulting that role with ask_agent:']
  for (const node of order) {
    const next = strategy.edges
      .filter((edge) => edge.from === node.id && edge.twoWay !== true)
      .map((edge) => `${label(edge.to)}${edge.contract !== undefined && edge.contract.trim().length > 0 ? ` (passing on: ${firstLine(edge.contract)})` : ''}`)
    lines.push(
      `${String(number.get(node.id))}. ${roleName(node.role)}${node.readOnly === true ? ' - read-only: may not change anything' : ''}${node.instructions !== undefined && node.instructions.trim().length > 0 ? ` - the user's instructions for it: "${firstLine(node.instructions)}"` : ' - what it does here is yours to plan'}` +
        (next.length > 0 ? `; then ${next.join(' and ')}` : ''),
    )
  }
  const loops = strategy.edges.filter((edge) => edge.twoWay === true)
  if (loops.length > 0) {
    lines.push('', 'Back-and-forth between roles:')
    for (const edge of loops) {
      const judge = label(edge.to)
      lines.push(
        `- ${label(edge.from)} and ${judge}: after ${label(edge.from)}, ${judge} checks; if not done, back to ${label(edge.from)}. ` +
          (edge.until !== undefined && edge.until.trim().length > 0 ? `Repeat until: "${edge.until.trim()}" (judged by ${judge}), ` : 'Repeat ') +
          `at most ${String(roundsOf(edge))} round${roundsOf(edge) === 1 ? '' : 's'}.${edge.label !== undefined ? ` (${edge.label})` : ''}` +
          (edge.contract !== undefined && edge.contract.trim().length > 0 ? ` Each round ${label(edge.from)} passes on: ${firstLine(edge.contract)}.` : ''),
      )
    }
  }
  const boxes = (strategy.groups ?? []).map((group) => ({ group, inside: order.filter((node) => node.group === group.id) })).filter((box) => box.inside.length > 1)
  if (boxes.length > 0) {
    lines.push('', 'In parallel (consult these together in ONE ask_agents call, and continue when all have answered):')
    for (const box of boxes) lines.push(`- ${box.group.label ?? 'Parallel'}: ${box.inside.map((node) => label(node.id)).join(', ')}`)
  }
  lines.push(
    '',
    'How to follow it:',
    '- Before doing anything else in a task, propose a plan with update_plan that carries out every step above in order, naming the role for each step and writing each back-and-forth as one step with its condition and its maximum rounds. Then follow the plan.',
    "- Give each specialist what it needs from the earlier steps: it does not see this conversation, only what you send it. A step's own instructions from the user reach it with every question; plan the steps that have none.",
    "- In a back-and-forth, Light Code counts the rounds and tells you after each answer where the loop stands; it refuses a round past the maximum. If the maximum is reached without the condition, stop and tell the user what is still open rather than working around it.",
    '- A question from the user that is not part of the strategy is answered normally.',
  )
  return lines.join('\n')
}

/** Where each back-and-forth stands in this chat, by connector id. Saved with the chat. */
export type StrategyProgress = Record<string, { rounds: number; met?: boolean; verdict?: string; awaiting?: boolean }>

/** The verdict line a judging role is asked for, read back. */
export function readVerdict(answer: string): { met: boolean; detail: string } | undefined {
  const lines = answer.trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    const m = /^\s*\**\s*CONDITION\s*:\s*(NOT\s+MET|MET)\b\**\s*[-:–—]?\s*(.*)$/i.exec(line)
    if (m !== null) return { met: !/^NOT/i.test(m[1]!), detail: (m[2] ?? '').trim() }
  }
  return undefined
}

export interface ConsultPlan {
  /** Set: refuse this consultation, with this sentence for the agent. */
  refuse?: string
  /** Appended to the specialist's question. */
  addToPrompt: string
  /** The role must not change anything in this consultation. */
  readOnly: boolean
}

/**
 * What the strategy says about consulting `role` now, given who was consulted last. Pure: the bridge keeps the
 * state and applies the answer with `afterConsult`.
 */
export function beforeConsult(strategy: Strategy, progress: StrategyProgress, lastRole: string | undefined, role: string, roleName: (r: string) => string): ConsultPlan {
  const nodes = strategy.nodes.filter((node) => node.role === role)
  const readOnly = nodes.length > 0 && nodes.every((node) => node.readOnly === true)
  const notes: string[] = []
  for (const edge of strategy.edges) {
    if (edge.twoWay !== true) continue
    const from = strategy.nodes.find((n) => n.id === edge.from)
    const to = strategy.nodes.find((n) => n.id === edge.to)
    if (from === undefined || to === undefined) continue
    const state = progress[edge.id] ?? { rounds: 0 }
    // Going back to the worker from the judge: the next round, which must exist.
    if (role === from.role && lastRole === to.role && state.met !== true && state.rounds >= roundsOf(edge)) {
      return {
        refuse:
          `The strategy allows at most ${String(roundsOf(edge))} round${roundsOf(edge) === 1 ? '' : 's'} between ${roleName(from.role)} and ${roleName(to.role)}, and all of them are used` +
          `${edge.until !== undefined ? ` without "${edge.until}" being met` : ''}${state.verdict !== undefined ? ` (last verdict: ${state.verdict})` : ''}. ` +
          'Stop this loop: tell the user what is still open and ask how to continue.',
        addToPrompt: '',
        readOnly,
      }
    }
    if (role === to.role && edge.until !== undefined && edge.until.trim().length > 0) {
      notes.push(
        `You are the judge of a back-and-forth with ${roleName(from.role)}, which ends when: "${edge.until.trim()}". ` +
          'Judge it against what you can check, and end your answer with exactly one line: `CONDITION: MET` or `CONDITION: NOT MET - <what is still missing>`.',
      )
    }
  }
  // What was agreed along each connector, told to both ends.
  for (const edge of strategy.edges) {
    const contract = edge.contract?.trim() ?? ''
    if (contract.length === 0) continue
    const from = strategy.nodes.find((n) => n.id === edge.from)
    const to = strategy.nodes.find((n) => n.id === edge.to)
    if (from === undefined || to === undefined) continue
    if (role === from.role) notes.push(`Your answer is passed on to ${roleName(to.role)}. As agreed, it must contain: ${contract}`)
    if (role === to.role) notes.push(`From ${roleName(from.role)} you are given, as agreed: ${contract}. If any of it is missing from the question, say exactly what is missing.`)
  }
  // The user's own instructions for this step, in full - the agent's question says what is needed now.
  const instructed = nodes.map((node) => node.instructions?.trim() ?? '').filter((text) => text.length > 0)
  if (instructed.length > 0) notes.unshift(`The user's instructions for you in this strategy:\n${[...new Set(instructed)].join('\n\n')}`)
  if (readOnly) notes.push('In this strategy you are read-only: you have no tools that change anything. Recommend changes; do not make them.')
  return { addToPrompt: notes.join('\n\n'), readOnly }
}

/** Records a consultation of `role` that ran; returns the progress and what to tell the main agent, if anything. */
export function afterConsult(
  strategy: Strategy,
  progress: StrategyProgress,
  role: string,
  answer: string,
  roleName: (r: string) => string,
): { progress: StrategyProgress; note?: string } {
  const next: StrategyProgress = { ...progress }
  const notes: string[] = []
  for (const edge of strategy.edges) {
    if (edge.twoWay !== true) continue
    const from = strategy.nodes.find((n) => n.id === edge.from)
    const to = strategy.nodes.find((n) => n.id === edge.to)
    if (from === undefined || to === undefined) continue
    const state = { ...(next[edge.id] ?? { rounds: 0 }) }
    if (role === from.role && role !== to.role) {
      state.awaiting = true
    } else if (role === to.role) {
      // A round is the worker and then the judge. The judge consulted first (to set the bar) is not a round.
      if (state.awaiting === true) state.rounds += 1
      state.awaiting = false
      const verdict = readVerdict(answer)
      if (verdict !== undefined) {
        state.met = verdict.met
        state.verdict = verdict.met ? 'met' : `not met${verdict.detail.length > 0 ? ` - ${verdict.detail}` : ''}`
      }
      const max = roundsOf(edge)
      const pair = `${roleName(from.role)} ⇄ ${roleName(to.role)}`
      if (state.met === true) {
        notes.push(`[Strategy] ${pair}: round ${String(state.rounds)} of ${String(max)} - ${roleName(to.role)} says the condition is met. This loop is done; go on to the next step.`)
      } else if (state.rounds >= max) {
        notes.push(`[Strategy] ${pair}: all ${String(max)} rounds used${state.verdict !== undefined ? ` (${state.verdict})` : ''}. Stop the loop and tell the user what is still open.`)
      } else if (state.rounds > 0 || edge.until !== undefined) {
        notes.push(
          `[Strategy] ${pair}: round ${String(state.rounds)} of ${String(max)}${state.verdict !== undefined ? ` - ${state.verdict}` : ''}. ` +
            (edge.until !== undefined ? `Not done until "${edge.until}": back to ${roleName(from.role)} with what ${roleName(to.role)} found.` : `Back to ${roleName(from.role)} if more is needed.`),
        )
      }
    }
    next[edge.id] = state
  }
  return { progress: next, ...(notes.length > 0 ? { note: notes.join('\n') } : {}) }
}

/**
 * Every consultation made under the strategy in this chat: who was asked what, what came back, and where its loop
 * stood. Asked for: "provide a way for user to see what was agreed between agents ... whats happening and why it
 * goes back and forth". Saved with the chat; the window shows it per connector, and `strategy_history` lets the
 * main agent explain it from the record rather than from memory.
 */
export interface StrategyExchange {
  at: number
  role: string
  question: string
  answer: string
  /** Consulted together with others in one `ask_agents` call. */
  parallel?: boolean
  /** The loops this answer moved, with the round and the verdict it gave. */
  loops?: { edgeId: string; rounds: number; verdict?: string; met?: boolean }[]
  /** Refused by the strategy (a round past the maximum), with why. */
  refused?: string
}

export const MAX_EXCHANGES = 200
const EXCHANGE_TEXT = 4_000

export function exchangeOf(role: string, question: string, answer: string, before: StrategyProgress, after: StrategyProgress, parallel: boolean): StrategyExchange {
  const cap = (text: string): string => (text.length <= EXCHANGE_TEXT ? text : `${text.slice(0, EXCHANGE_TEXT)}… [${String(text.length - EXCHANGE_TEXT)} more characters]`)
  const loops = Object.entries(after)
    .filter(([id, state]) => JSON.stringify(state) !== JSON.stringify(before[id]))
    .map(([edgeId, state]) => ({ edgeId, rounds: state.rounds, ...(state.verdict !== undefined ? { verdict: state.verdict } : {}), ...(state.met !== undefined ? { met: state.met } : {}) }))
  return { at: Date.now(), role, question: cap(question), answer: cap(answer), ...(parallel ? { parallel: true } : {}), ...(loops.length > 0 ? { loops } : {}) }
}
