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
  /**
   * A decision step: once this step has answered, the decision model (Settings → Agents) picks which of its outgoing
   * connectors to follow, by their labels and where they lead - from its answer. Without a decision model, or when it
   * is not sure, the main agent chooses as before. `decisionQuestion` is the question it is asked, if not the default.
   */
  decides: z.boolean().optional(),
  decisionQuestion: z.string().max(500).optional(),
})

/**
 * A box of steps. Two kinds:
 * - `parallel` (the default, and every box saved before kinds existed): the steps inside are consulted at the same
 *   moment (`ask_agents`), each specialist in its own process;
 * - `together`: a group of steps done in their own order (by the connectors between them, else as drawn).
 *
 * Either way the box is one step of the flow: a connector may start or end at the box itself, and the strategy
 * moves on along a connector leaving the box only when every step inside has answered. Asked for: "there is no
 * arrow connecting option from parallel box to another agent or another box, introduce normal boxes that can
 * have group of agent under it, when they all completed then it can flow to next agent that is connected to box".
 */
export const strategyGroupSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(80).optional(),
  kind: z.enum(['parallel', 'together']).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().min(60),
  h: z.number().finite().min(40),
})

export const strategyEdgeSchema = z.object({
  id: z.string().min(1).max(40),
  /** A step's id, or a box's (`StrategyGroup.id`): from a box means "once every step inside has answered". */
  from: z.string().min(1).max(40),
  /** A step's id, or a box's: to a box means every step inside starts from what arrives. */
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
  /**
   * What the contract requires, item by item ("Changed files", "Tests run") - checked, not hoped for. The sender is
   * told to give each on a line of its own, "Item: ...", and after it answers Light Code checks every item is there
   * and asks the same specialist for the missing ones (twice at most) before anything moves on. See `contractCheck`.
   */
  requires: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
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

/** A box's kind; a box saved before kinds existed is a parallel one. */
export function groupKind(group: StrategyGroup): 'parallel' | 'together' {
  return group.kind ?? 'parallel'
}

export function groupName(group: StrategyGroup): string {
  return group.label?.trim() || (groupKind(group) === 'parallel' ? 'Parallel box' : 'Box')
}

/** The steps inside a box. */
export function groupMembers(strategy: Strategy, groupId: string): StrategyNode[] {
  return strategy.nodes.filter((node) => node.group === groupId)
}

/** The steps a connector end stands for: the step itself, or every step inside a box. */
export function endpointNodes(strategy: Strategy, id: string): StrategyNode[] {
  const node = strategy.nodes.find((n) => n.id === id)
  if (node !== undefined) return [node]
  return (strategy.groups ?? []).some((group) => group.id === id) ? groupMembers(strategy, id) : []
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
  const groups = new Map((strategy.groups ?? []).map((group) => [group.id, group]))
  const pairs = new Set<string>()
  for (const edge of strategy.edges) {
    if ((!ids.has(edge.from) && !groups.has(edge.from)) || (!ids.has(edge.to) && !groups.has(edge.to))) problems.push('A connector points at a step that is not there.')
    if (edge.from === edge.to) problems.push('A connector goes from a step to itself.')
    if (edge.twoWay === true && (groups.has(edge.from) || groups.has(edge.to))) {
      problems.push('A back-and-forth joins two steps, not a box: connect it to one step inside the box.')
    }
    const fromNode = strategy.nodes.find((n) => n.id === edge.from)
    const toNode = strategy.nodes.find((n) => n.id === edge.to)
    if ((groups.has(edge.to) && fromNode?.group === edge.to) || (groups.has(edge.from) && toNode?.group === edge.from)) {
      problems.push('A connector joins a box to a step inside it; connect the steps inside to each other instead.')
    }
    const pair = [edge.from, edge.to].sort().join('|')
    if (edge.twoWay === true && pairs.has(pair)) problems.push('Two back-and-forth connectors join the same two steps.')
    if (edge.twoWay === true) pairs.add(pair)
  }
  for (const group of strategy.groups ?? []) {
    const inside = groupMembers(strategy, group.id)
    if (inside.length === 0 && strategy.edges.some((edge) => edge.from === group.id || edge.to === group.id)) {
      problems.push(`${groupName(group)} is connected but has no steps inside.`)
    }
    if (groupKind(group) !== 'parallel') continue
    const roles = inside.map((node) => node.role)
    if (new Set(roles).size !== roles.length) problems.push(`${groupName(group)} holds one role twice; one specialist answers one question at a time, so they would not run in parallel.`)
  }
  return [...new Set(problems)]
}

/**
 * The order to read the chart in: steps nobody points to first, then breadth-first along one-way connectors (a
 * back-and-forth counts as going from `from` to `to`), ties by position on the canvas, left to right. A box is
 * ordered as one unit - a connector to or from any step inside counts as the box's - and its steps are listed
 * together, in their own order inside it. Steps a cycle hides are added at the end in canvas order, so every step
 * appears once.
 */
export function strategyOrder(strategy: Strategy): StrategyNode[] {
  const groups = new Set((strategy.groups ?? []).map((group) => group.id))
  const unitOf = (id: string): string => {
    if (groups.has(id)) return id
    const node = strategy.nodes.find((n) => n.id === id)
    return node?.group !== undefined && groups.has(node.group) ? node.group : id
  }
  const position = (unit: string): { x: number; y: number } => {
    const group = strategy.groups?.find((g) => g.id === unit)
    if (group !== undefined) return group
    return strategy.nodes.find((n) => n.id === unit) ?? { x: 0, y: 0 }
  }
  const canvasUnits = (a: string, b: string): number => position(a).x - position(b).x || position(a).y - position(b).y
  const units = [...new Set(strategy.nodes.map((node) => unitOf(node.id)))]
  const between = strategy.edges.map((edge) => ({ from: unitOf(edge.from), to: unitOf(edge.to) })).filter((edge) => edge.from !== edge.to)
  const order = orderBy(units, between, canvasUnits)

  const canvas = (a: StrategyNode, b: StrategyNode): number => a.x - b.x || a.y - b.y
  const out: StrategyNode[] = []
  for (const unit of order) {
    if (!groups.has(unit)) {
      const node = strategy.nodes.find((n) => n.id === unit)
      if (node !== undefined) out.push(node)
      continue
    }
    const inside = groupMembers(strategy, unit)
    const ids = new Set(inside.map((node) => node.id))
    const inner = strategy.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    const byId = new Map(inside.map((node) => [node.id, node]))
    for (const id of orderBy(inside.map((node) => node.id), inner, (a, b) => canvas(byId.get(a)!, byId.get(b)!))) out.push(byId.get(id)!)
  }
  return out
}

/** Breadth-first from the items nothing points to, ties by `compare`; anything a cycle hides is added at the end. */
function orderBy(items: readonly string[], edges: readonly { from: string; to: string }[], compare: (a: string, b: string) => number): string[] {
  const incoming = new Map<string, number>(items.map((item) => [item, 0]))
  for (const edge of edges) if (incoming.has(edge.to) && incoming.has(edge.from)) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  const queue = items.filter((item) => (incoming.get(item) ?? 0) === 0).sort(compare)
  const seen = new Set<string>()
  const out: string[] = []
  while (queue.length > 0) {
    const item = queue.shift()!
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
    const next = [...new Set(edges.filter((edge) => edge.from === item && incoming.has(edge.to) && !seen.has(edge.to)).map((edge) => edge.to))].sort(compare)
    queue.push(...next)
  }
  for (const item of [...items].sort(compare)) if (!seen.has(item)) out.push(item)
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
  const groups = strategy.groups ?? []
  const label = (id: string): string => {
    const node = strategy.nodes.find((n) => n.id === id)
    if (node !== undefined) return `${roleName(node.role)} (step ${String(number.get(id) ?? '?')})`
    const group = groups.find((g) => g.id === id)
    if (group === undefined) return id
    const inside = groupMembers(strategy, id).map((member) => number.get(member.id)).filter((n): n is number => n !== undefined).sort((a, b) => a - b)
    return `the box "${groupName(group)}" (step${inside.length === 1 ? '' : 's'} ${inside.join(', ')})`
  }
  const onward = (edge: StrategyEdge): string =>
    `${label(edge.to)}${edge.contract !== undefined && edge.contract.trim().length > 0 ? ` (passing on: ${firstLine(edge.contract)})` : ''}${requiredOf(edge).length > 0 && !groups.some((g) => g.id === edge.from) ? ` [required: ${requiredOf(edge).join(', ')}]` : ''}`
  /*
   * A custom role's name ("Security Reviewer") is not what ask_agent takes; its id is. Said once per step, so the agent
   * asks for the role the user drew rather than guessing an id from the name.
   */
  const askAs = (role: string): string => (roleName(role).trim().toLowerCase() === role ? '' : ` (ask_agent role "${role}")`)
  const lines = [`## Strategy: ${strategy.name}`, '', 'The user drew how this work must be done. Steps, each done by consulting that role with ask_agent:']
  const announced = new Set<string>()
  for (const node of order) {
    // A box is introduced at its first step, with what it waits for.
    const group = node.group === undefined ? undefined : groups.find((g) => g.id === node.group)
    if (group !== undefined && !announced.has(group.id)) {
      announced.add(group.id)
      const into = strategy.edges.filter((edge) => edge.to === group.id).map((edge) => label(edge.from))
      lines.push(
        `${label(group.id)[0]!.toUpperCase()}${label(group.id).slice(1)} - ${groupKind(group) === 'parallel' ? 'consulted together, in ONE ask_agents call' : 'done as a group, in the order below'}${into.length > 0 ? `, after ${into.join(' and ')}` : ''}:`,
      )
    }
    const next = strategy.edges.filter((edge) => edge.from === node.id && edge.twoWay !== true).map(onward)
    lines.push(
      `${group !== undefined ? '   ' : ''}${String(number.get(node.id))}. ${roleName(node.role)}${askAs(node.role)}${node.readOnly === true ? ' - read-only: may not change anything' : ''}${node.instructions !== undefined && node.instructions.trim().length > 0 ? ` - the user's instructions for it: "${firstLine(node.instructions)}"` : ' - what it does here is yours to plan'}` +
        (next.length > 0 ? `; then ${next.join(' and ')}` : '') +
        (node.decides === true && next.length > 1 ? ' - a decision step: once it answers, the decision model picks which way to go and you are told; if no pick comes, choose yourself' : ''),
    )
    // After the box's last step: where the flow goes once every step inside has answered.
    if (group !== undefined) {
      const members = groupMembers(strategy, group.id)
      const last = order.filter((n) => members.some((m) => m.id === n.id)).at(-1)
      if (last?.id === node.id) {
        const after = strategy.edges.filter((edge) => edge.from === group.id).map(onward)
        if (after.length > 0) lines.push(`   When every step in ${label(group.id)} has answered: then ${after.join(' and ')}.`)
      }
    }
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
          (edge.contract !== undefined && edge.contract.trim().length > 0 ? ` Each round ${label(edge.from)} passes on: ${firstLine(edge.contract)}.` : '') +
          (requiredOf(edge).length > 0 ? ` Required in every hand-over: ${requiredOf(edge).join(', ')}.` : ''),
      )
    }
  }
  const boxes = groups.map((group) => ({ group, inside: order.filter((node) => node.group === group.id) })).filter((box) => box.inside.length > 1)
  const parallel = boxes.filter((box) => groupKind(box.group) === 'parallel')
  if (parallel.length > 0) {
    lines.push('', 'In parallel (consult these together in ONE ask_agents call, and continue when all have answered):')
    for (const box of parallel) lines.push(`- ${groupName(box.group)}: ${box.inside.map((node) => label(node.id)).join(', ')}`)
  }
  if (boxes.length > 0) {
    lines.push('', 'A connector leaving a box is followed only once every step inside it has answered. A connector into a box gives every step inside what arrives along it.')
  }
  lines.push(
    '',
    'How to follow it:',
    '- This strategy applies to every piece of work asked for in this chat, not only the first. Before doing anything else for a request - including a new topic after an earlier one is finished - propose a plan with update_plan that carries out every step above in order for that request, naming the role for each step and writing each back-and-forth as one step with its condition and its maximum rounds. Then follow the plan. A new plan for a new topic starts the loops afresh; do not reuse an earlier topic\'s plan or skip the specialists because they were consulted before.',
    "- Each specialist works in its own context and does not see this conversation. Light Code hands each step the latest full answers of the steps connected into it, directly - do not paste earlier specialists' answers into your question. Say what this step should do now, and add only what it cannot get that way: the user's request and anything from this conversation it needs. You are given each specialist's summary, not its whole answer; read the full one with strategy_history only when you need the detail. A step's own instructions from the user reach it with every question; plan the steps that have none.",
    '- Connectors with no contract: before starting, propose what should pass along them with set_strategy_contracts (the user approves it). Light Code checks every required item after each answer, asks the specialist again for what is missing, and tells you if it is still missing - pass on what arrived, and say what did not.',
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
  // Required items, checked after the answer: told to the sender with the one format the check reads.
  for (const edge of strategy.edges) {
    const items = requiredOf(edge)
    // Checked on one step's answer, so only on a connector leaving a step; from a box the items are part of the contract.
    const from = strategy.nodes.find((n) => n.id === edge.from)
    if (items.length === 0 || from === undefined || endpointNodes(strategy, edge.to).length === 0 || role !== from.role) continue
    notes.push(
      `Required in your answer for ${targetName(strategy, edge.to, roleName)}, each on a line of its own starting with its name and a colon:\n` +
        items.map((item) => `${item}: ...`).join('\n') +
        '\nLight Code checks these and will ask you again for any that are missing.',
    )
  }
  // What was agreed along each connector, told to both ends - every step inside a box, when an end is a box.
  const endName = (id: string): string => targetName(strategy, id, roleName)
  for (const edge of strategy.edges) {
    const fromBox = strategy.groups?.some((g) => g.id === edge.from) === true
    // Out of a box the required items cannot be checked on one answer, so they are part of what is agreed.
    const items = fromBox ? requiredOf(edge) : []
    const contract = [edge.contract?.trim() ?? '', items.length > 0 ? `each of ${items.join(', ')}` : ''].filter((part) => part.length > 0).join('; ')
    if (contract.length === 0) continue
    const from = endpointNodes(strategy, edge.from)
    const to = endpointNodes(strategy, edge.to)
    if (from.length === 0 || to.length === 0) continue
    if (from.some((n) => n.role === role)) {
      notes.push(
        fromBox
          ? `Your answer, with the others from ${endName(edge.from)}, is passed on to ${endName(edge.to)}. As agreed, together they must contain: ${contract}. Give your part of it.`
          : `Your answer is passed on to ${endName(edge.to)}. As agreed, it must contain: ${contract}`,
      )
    }
    if (to.some((n) => n.role === role)) notes.push(`From ${endName(edge.from)} you are given, as agreed: ${contract}. If any of it is missing from the question, say exactly what is missing.`)
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
  /**
   * Verdicts the decision model gave, by edge id. Where one is given it decides the loop instead of the judge's
   * wording; where none is (no decision model, or not sure enough), the wording decides as before.
   */
  judged?: ReadonlyMap<string, { met: boolean; detail: string }>,
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
      const byModel = judged?.get(edge.id)
      const verdict = byModel ?? readVerdict(answer)
      if (verdict !== undefined) {
        state.met = verdict.met
        state.verdict = verdict.met ? 'met' : `not met${verdict.detail.length > 0 ? ` - ${verdict.detail}` : ''}`
      }
      const max = roundsOf(edge)
      const pair = `${roleName(from.role)} ⇄ ${roleName(to.role)}`
      if (state.met === true) {
        notes.push(`[Strategy] ${pair}: round ${String(state.rounds)} of ${String(max)} - ${byModel !== undefined ? `the decision model says the condition is met (${byModel.detail})` : `${roleName(to.role)} says the condition is met`}. This loop is done; go on to the next step.`)
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
  /** The contracts this answer had to keep: what was required, what was still missing, and how many times it was asked again. */
  contracts?: { edgeId: string; to: string; required: string[]; missing: string[]; askedAgain: number }[]
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

export function requiredOf(edge: StrategyEdge): string[] {
  return (edge.requires ?? []).map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * The required items an answer does not give: an item counts when a line starts with its name (any case, bold or a
 * heading allowed) followed by a colon or a dash, with something after it - or a heading with its name followed by
 * text on the next lines. Deterministic and cheap: no model is asked whether a contract was kept.
 */
export function missingItems(answer: string, items: readonly string[]): string[] {
  const lines = answer.split(/\r?\n/)
  const norm = (text: string): string => text.toLowerCase().replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  const given = (wanted: string): boolean =>
    lines.some((line, i) => {
      const clean = norm(line)
      if (!clean.startsWith(wanted)) return false
      const after = clean.slice(wanted.length).trim()
      // "Changed files: a.ts" or "Changed files - a.ts"
      if (/^[:\-–—]\s*\S/.test(after)) return true
      // "## Changed files" (or "Changed files:") with its content on the next non-empty line, which is not a heading
      if (after !== '' && after !== ':') return false
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0)
      return next !== undefined && !next.trim().startsWith('#')
    })
  return items.filter((item) => !given(norm(item)))
}

/** The contracts `role` sends along, with what its answer leaves out. Only connectors with required items. */
export function contractCheck(strategy: Strategy, role: string, answer: string): { edgeId: string; to: string; required: string[]; missing: string[] }[] {
  const out: { edgeId: string; to: string; required: string[]; missing: string[] }[] = []
  for (const edge of strategy.edges) {
    const items = requiredOf(edge)
    const from = strategy.nodes.find((n) => n.id === edge.from)
    if (items.length === 0 || from === undefined || from.role !== role) continue
    const toNode = strategy.nodes.find((n) => n.id === edge.to)
    const toGroup = strategy.groups?.find((g) => g.id === edge.to)
    if (toNode === undefined && toGroup === undefined) continue
    out.push({ edgeId: edge.id, to: toNode?.role ?? groupName(toGroup!), required: items, missing: missingItems(answer, items) })
  }
  return out
}

/** What a connector's far end is called in a specialist's instructions: a role, or a box with what is inside. */
function targetName(strategy: Strategy, id: string, roleName: (role: string) => string): string {
  const node = strategy.nodes.find((n) => n.id === id)
  if (node !== undefined) return roleName(node.role)
  const group = strategy.groups?.find((g) => g.id === id)
  if (group === undefined) return id
  return `the box "${groupName(group)}" (${groupMembers(strategy, id).map((n) => roleName(n.role)).join(', ')})`
}

/** What the specialist is asked when its answer left items out. Carries its answer, for one without memory. */
export function askForMissing(missing: readonly string[], previous: string): string {
  return [
    `Your answer is missing what the strategy requires: ${missing.join(', ')}.`,
    `Give only these now, each on a line of its own starting with its name and a colon (${missing.map((m) => `"${m}: ..."`).join(', ')}).`,
    'If one does not apply, say so on its line rather than leaving it out.',
    '',
    'Your previous answer, for reference:',
    previous.length > 6_000 ? `${previous.slice(0, 6_000)}…` : previous,
  ].join('\n')
}

/**
 * The roles whose latest answer a consultation of `role` is handed directly: every step connected into one of its steps
 * (a box's steps when the connector starts at a box), and in a back-and-forth the other side - the judge sees the
 * worker's latest, the worker the judge's findings. Asked for: specialists keep their own context, and the main chat
 * must not fill up following the strategy - so a hand-over goes from specialist to specialist, not through the main
 * agent's question.
 */
export function handOverSources(strategy: Strategy, role: string): string[] {
  const mine = strategy.nodes.filter((node) => node.role === role)
  if (mine.length === 0) return []
  const ids = new Set(mine.map((node) => node.id))
  const groups = new Set(mine.map((node) => node.group).filter((group): group is string => group !== undefined))
  const into = (edge: StrategyEdge): boolean => ids.has(edge.to) || groups.has(edge.to)
  const sources = new Set<string>()
  for (const edge of strategy.edges) {
    if (into(edge)) for (const node of endpointNodes(strategy, edge.from)) sources.add(node.role)
    if (edge.twoWay === true && (ids.has(edge.from) || groups.has(edge.from))) for (const node of endpointNodes(strategy, edge.to)) sources.add(node.role)
  }
  sources.delete(role)
  return [...sources]
}

/** What a specialist under a strategy is asked to end with, so the main agent can be given that instead of everything. */
export const SUMMARY_HEADING = 'Summary for the main agent'

export const SUMMARY_REQUEST =
  `Your full answer is kept and passed on to the next step of the strategy directly. End it with a section headed "${SUMMARY_HEADING}:" - ` +
  'at most eight short lines: what you did or found, any decision the main agent must make, and anything blocking. ' +
  'Only that section reaches the main agent.'

const SUMMARY_LIMIT = 2_000
/** Answers this short reach the main agent whole: summarising them saves nothing. */
const SHORT_ANSWER = 2_500

/**
 * What of a specialist's answer the main agent is given: its summary section when it wrote one, the whole answer when it
 * is short, else its beginning - each with a pointer to the full text, which stays in the strategy record.
 */
export function answerForMain(answer: string, role: string): string {
  const lines = answer.split(/\r?\n/)
  const heading = lines.findIndex((line) => /^\s*(?:#+\s*)?(?:\*\*)?\s*summary for the main agent\b/i.test(line))
  if (heading >= 0) {
    const first = lines[heading]!.replace(/^\s*(?:#+\s*)?(?:\*\*)?\s*summary for the main agent\s*:?\s*(?:\*\*)?\s*:?\s*/i, '')
    const summary = [first, ...lines.slice(heading + 1)].join('\n').trim()
    if (summary.length > 0) {
      const cut = summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT)}…` : summary
      return `${cut}\n\n[The ${role}'s full answer (${String(answer.length)} characters) was passed to the next step directly and is in the strategy record; read it with strategy_history only if you need the detail.]`
    }
  }
  if (answer.length <= SHORT_ANSWER) return answer
  return `${answer.slice(0, SUMMARY_LIMIT)}…\n\n[Shortened for you: the ${role}'s full answer (${String(answer.length)} characters) was passed to the next step directly and is in the strategy record; read it with strategy_history only if you need the detail.]`
}

/**
 * The decision step after `role` answered: the connectors it may follow, as options for the decision model, and the
 * question - or undefined when no step of this role decides or it has fewer than two ways on.
 */
export function branchChoice(
  strategy: Strategy,
  role: string,
  roleName: (r: string) => string,
): { question: string; options: { id: string; label: string; description?: string }[] } | undefined {
  const node = strategy.nodes.find((candidate) => candidate.role === role && candidate.decides === true)
  if (node === undefined) return undefined
  const ways = strategy.edges.filter((edge) => edge.from === node.id && edge.twoWay !== true)
  if (ways.length < 2) return undefined
  const targetLabel = (id: string): string => {
    const target = strategy.nodes.find((candidate) => candidate.id === id)
    if (target !== undefined) return roleName(target.role)
    const group = (strategy.groups ?? []).find((candidate) => candidate.id === id)
    return group !== undefined ? (group.label ?? 'the box') : id
  }
  return {
    question: node.decisionQuestion !== undefined && node.decisionQuestion.trim().length > 0 ? node.decisionQuestion.trim() : `Given ${roleName(role)}'s answer, which step should come next?`,
    options: ways.map((edge) => ({ id: edge.id, label: targetLabel(edge.to), ...(edge.label !== undefined && edge.label.trim().length > 0 ? { description: edge.label.trim() } : {}) })),
  }
}
