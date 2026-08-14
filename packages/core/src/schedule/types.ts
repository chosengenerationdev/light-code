import { z } from 'zod'

/**
 * Prompts that run without anyone watching (Phase 9b).
 *
 * ## The core problem, and how this differs from the plan
 *
 * §8 says approval is per-invocation and every auto-approve toggle ships off. A scheduled run
 * has nobody to approve anything, so it cannot inherit that model — and "just auto-approve
 * everything while it runs" is exactly the hole §8 exists to prevent.
 *
 * The plan resolved this with a **mode** per schedule: read-only by default, widened per
 * schedule with a warning. What is built instead is an explicit **per-tool allowlist**, which
 * is strictly finer: a mode grants a whole group, so allowing one MCP tool would have allowed
 * every MCP tool. Naming tools individually means a schedule that may post to one endpoint
 * cannot also delete from another. The warning logic the plan asked for still applies, keyed
 * on the groups the chosen tools belong to.
 *
 * The allowlist is an **allowlist, not a denylist**: a tool absent from it does not run, so a
 * newly installed MCP server is never silently granted to an existing schedule.
 *
 * ## The combination that must never be the default
 *
 * Unattended execution + edit or command tools + anything that reads outside the workspace is
 * a direct prompt-injection to code-execution path: the job reads a page or a ticket, the text
 * contains instructions, and the model acts on them with nobody watching. A new schedule
 * therefore starts with **nothing selected**, and the UI says this plainly when the selection
 * includes a tool that writes or executes.
 */

/**
 * When a schedule fires.
 *
 * Deliberately **not cron**. CLAUDE.md says not to hand-roll a cron parser, and it is right —
 * the edge cases around day-of-week versus day-of-month alone are a subtle-bug factory. Rather
 * than take a dependency for expressiveness nobody has asked for, this is a smaller spec that
 * cannot be got subtly wrong and covers what people actually schedule. Real cron remains one
 * vetted dependency away if these prove too rigid.
 */
export const scheduleTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    /** Bounded below at a minute: anything faster is a loop, not a schedule. */
    everyMinutes: z.number().int().min(1).max(60 * 24 * 7),
  }),
  z.object({
    kind: z.literal('daily'),
    /** Local time, 24-hour. Local because a person thinks "before I arrive", not in UTC. */
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal('weekly'),
    /** 0 = Sunday, matching `Date.getDay()` so no translation layer can get it wrong. */
    days: z.array(z.number().int().min(0).max(6)).min(1),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
])
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>

export const scheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** What gets sent, exactly as if typed into the composer. */
  prompt: z.string().min(1),
  trigger: scheduleTriggerSchema,
  enabled: z.boolean(),
  /**
   * The only tools this run may use, by exact name — built-in, MCP or Python alike.
   *
   * Empty means the run can do nothing but answer, which is a legitimate and safe schedule.
   * Control tools are always available regardless; they perform no work.
   */
  allowedTools: z.array(z.string()),
  /** Epoch ms. Absent until it has run once. */
  lastRunAt: z.number().optional(),
  lastResult: z.enum(['ok', 'error', 'cancelled']).optional(),
  lastSummary: z.string().optional(),
  /** The task this schedule last produced, so a notification can open it. */
  lastTaskId: z.string().optional(),
})
export type Schedule = z.infer<typeof scheduleSchema>

/** Persisted as a map so an id is unique by construction rather than by convention. */
export const schedulesSchema = z.record(z.string(), scheduleSchema)
export type Schedules = z.infer<typeof schedulesSchema>

/**
 * Tools that always run, whatever the allowlist says.
 *
 * These perform no work: they are how the model finishes or reports. Excluding them would make
 * every schedule unable to say it had completed, and the run would look like a hang.
 *
 * `ask_followup_question` is deliberately **not** here. There is nobody to answer it, so a run
 * that asked would wait for a reply that never comes — see `runner.ts`.
 */
export const ALWAYS_AVAILABLE_TO_SCHEDULES = ['attempt_completion', 'notify'] as const

/** Groups whose presence in a schedule's allowlist warrants a warning in the UI. */
export function riskyGroupsIn(tools: readonly { name: string; group: string }[], allowed: readonly string[]): string[] {
  const selected = new Set(allowed)
  const groups = new Set<string>()
  for (const tool of tools) {
    if (!selected.has(tool.name)) continue
    if (tool.group === 'edit' || tool.group === 'command' || tool.group === 'mcp') groups.add(tool.group)
  }
  return [...groups].sort()
}
