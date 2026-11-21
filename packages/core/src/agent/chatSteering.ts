import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { strategySchema, type Strategy, type StrategyExchange, type StrategyProgress } from '../strategy/strategy.js'
import { writeFileAtomically } from '../usage/events.js'
import type { PlanProgress } from './checkpoints.js'
import { isSkillToolPicks, type SkillToolPicks } from '../decision/more.js'

/**
 * What steers one chat besides its conversation: the plan and the strategy, with where each stands. Saved with the
 * chat's task once it has a message; before that - a strategy chosen for a new chat, or the one a handoff carried
 * into the chat it opened - nothing was written, so a window reload or a Fire Code chat waking up lost it. Asked
 * for: "if i have different chats, i should be able to keep different strategy for different chats, it should be
 * persisted".
 *
 * Kept per workspace in the host's own storage (in Fire Code that folder is the chat's), never in the repository,
 * and removed as soon as the chat's first save carries the same thing.
 */
export interface ChatSteering {
  plan?: string
  planProgress?: PlanProgress
  strategy?: Strategy
  strategyProgress?: StrategyProgress
  strategyExchanges?: StrategyExchange[]
  /** What the decision model picks for each request in this chat - skills, tools or both (per chat, carried on). */
  skillToolPicks?: SkillToolPicks
}

export function pendingSteeringFile(storageDir: string, workspaceRoot: string): string {
  const key = createHash('sha256').update(process.platform === 'win32' ? path.resolve(workspaceRoot).toLowerCase() : path.resolve(workspaceRoot)).digest('hex').slice(0, 16)
  return path.join(storageDir, 'pending-chat', `${key}.json`)
}

export async function writePendingSteering(file: string, steering: ChatSteering): Promise<void> {
  if (steering.plan === undefined && steering.strategy === undefined && steering.skillToolPicks === undefined) {
    await clearPendingSteering(file)
    return
  }
  await writeFileAtomically(file, JSON.stringify({ version: 1, ...steering }))
}

export async function clearPendingSteering(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => undefined)
}

/** The saved steering, checked: an unreadable or damaged file is no steering, never an error. */
export async function readPendingSteering(file: string): Promise<ChatSteering | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const out: ChatSteering = {}
  if (typeof value['plan'] === 'string' && value['plan'].trim().length > 0) out.plan = value['plan']
  if (isSkillToolPicks(value['skillToolPicks'])) out.skillToolPicks = value['skillToolPicks']
  if (value['planProgress'] !== null && typeof value['planProgress'] === 'object') out.planProgress = value['planProgress'] as PlanProgress
  const strategy = strategySchema.safeParse(value['strategy'])
  if (strategy.success) {
    out.strategy = strategy.data
    if (value['strategyProgress'] !== null && typeof value['strategyProgress'] === 'object') out.strategyProgress = value['strategyProgress'] as StrategyProgress
    if (Array.isArray(value['strategyExchanges'])) out.strategyExchanges = value['strategyExchanges'] as StrategyExchange[]
  }
  return out.plan === undefined && out.strategy === undefined ? undefined : out
}
