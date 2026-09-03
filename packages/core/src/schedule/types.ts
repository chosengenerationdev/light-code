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
  /**
   * The project this schedule belongs to.
   *
   * Schedules were a single global list, so one written against project A fired whatever project
   * happened to be open — running its prompt, with its granted tools, against B's files. For a
   * schedule that was granted editing that is not a scoping gap but a hazard.
   *
   * Absent means "any project", which is what every schedule written before this had to mean:
   * silently binding them to whichever workspace was open at upgrade time would have stopped
   * them firing with no explanation.
   */
  workspaceRoot: z.string().optional(),
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
  /**
   * Which skills this run is told about, by name.
   *
   * **Absent means all of them**, which is what every schedule written before this existed
   * means, and the only reading that cannot silently take knowledge away from a job that was
   * working. An empty array is a real choice — "this run needs none" — and is honoured.
   *
   * Why a list rather than the retrieval the chat uses: a scheduled run's tools are an
   * allowlist the user ticked, and it may well not include `search_docs`, so telling the run
   * that notes exist and to go and search for them can leave it with nothing to search with.
   * Choosing the relevant ones up front is also simply better for a job that does the same
   * thing every night — it knows in advance which conventions apply, where the chat cannot.
   */
  allowedSkills: z.array(z.string()).optional(),
  /**
   * When the timer will next run this, in epoch ms.
   *
   * **Stored rather than derived on every tick.** A "when next?" function always answers with
   * a future moment, so comparing it against the clock can never say "due" — which is exactly
   * how every schedule came to silently never fire. Persisting the target makes the decision a
   * plain comparison, and it survives a restart.
   */
  nextRunAt: z.number().optional(),
  /** Epoch ms. Absent until it has run once. */
  lastRunAt: z.number().optional(),
  lastResult: z.enum(['ok', 'error', 'cancelled']).optional(),
  lastSummary: z.string().optional(),
  /** The task this schedule last produced, so a notification can open it. */
  lastTaskId: z.string().optional(),
  /**
   * Recent runs, newest first and bounded.
   *
   * Kept on the schedule rather than derived from task history: a run's *task* can be deleted,
   * and "it ran at 03:00 and failed" is worth keeping even when the transcript is gone. The
   * cap exists because this lives in the config file — an unbounded log there would grow
   * without limit and be rewritten on every run.
   */
  runs: z
    .array(
      z.object({
        at: z.number(),
        result: z.enum(['ok', 'error', 'cancelled']),
        durationMs: z.number().optional(),
        summary: z.string().optional(),
        /** Absent once the task has been deleted from history. */
        taskId: z.string().optional(),
        /**
         * A report this run wrote, if it wrote one.
         *
         * Kept as a path because the point of an unattended run is that nobody was watching: the
         * notification is gone by morning, and an in-memory document dies with the window. The
         * report has to be somewhere it can still be opened hours later, and findable from the
         * run that produced it rather than only from a toast that has since disappeared.
         */
        reportPath: z.string().optional(),
      }),
    )
    .optional(),
})
export type Schedule = z.infer<typeof scheduleSchema>
export type ScheduleRun = NonNullable<Schedule['runs']>[number]

/** How many runs a schedule remembers. Enough to spot a pattern, small enough for a config file. */
export const MAX_REMEMBERED_RUNS = 20

/** Persisted as a map so an id is unique by construction rather than by convention. */
export const schedulesSchema = z.record(z.string(), scheduleSchema)
export type Schedules = z.infer<typeof schedulesSchema>

/**
 * Tools that always run, whatever the allowlist says.
 *
 * Two kinds, and the distinction is the whole safety argument: these either **perform no work**
 * or **only read what the run itself already has**. Nothing here can reach the workspace, the
 * network or a process, so granting them by default widens nothing.
 *
 * - `attempt_completion` and `notify` are how a run finishes and reports. Excluding them would
 *   make every schedule unable to say it had completed, and the run would look like a hang.
 * - `read_tool_result` re-reads output this same run produced and had truncated. Without it a
 *   long command's output is unrecoverable *to the run that ran it*, which is a strange way to
 *   fail and reads as the tool having returned nothing.
 * - `search_docs` and `call_tool` were added 2026-09-01, at the user's request: a scheduled run
 *   "should be able to search docs and learn about skills and tools". Neither grants access to
 *   anything. `search_docs` reads the documentation index, and `call_tool` is a wrapper — the
 *   loop rewrites it into the call it stands for *before* the gate, so the inner tool is checked
 *   against the allowlist exactly as if it had been named directly.
 *
 * `call_tool` is a convenience rather than a necessity, and it is worth being precise because
 * the chat makes it look otherwise. There, MCP and Python tools are registered `dispatchOnly`
 * and reachable only through the dispatcher. A schedule builds a *fresh* registry from what it
 * was granted and registers those plainly, so a granted tool is advertised to the run directly.
 * What `call_tool` buys is that `search_docs` output says "call it with call_tool(...)", and
 * that instruction has to work. It cannot widen anything: the dispatcher resolves names against
 * the same restricted registry, so a tool the schedule did not name is not there to be found.
 * `schedule/discovery.test.ts` pins both halves.
 *
 * `ask_followup_question` is deliberately **not** here. There is nobody to answer it, so a run
 * that asked would wait for a reply that never comes — see `runner.ts`. `ask_user_form` is
 * excluded for the same reason, and is not offered to a scheduled run at all.
 */
export const ALWAYS_AVAILABLE_TO_SCHEDULES = [
  'attempt_completion',
  'notify',
  'read_tool_result',
  'search_docs',
  'call_tool',
] as const

/** Groups whose presence in a schedule's allowlist warrants a warning in the UI. */
/**
 * The skills a scheduled run is told about.
 *
 * Absent means all — see `allowedSkills`. Names that no longer resolve are dropped silently
 * rather than reported: a skill can be deleted or renamed long after a schedule was written,
 * and failing a nightly job over a stale name in a list of hints would be a poor trade.
 */
export function skillsForSchedule<T extends { name: string }>(
  skills: readonly T[],
  allowed: readonly string[] | undefined,
): T[] {
  if (allowed === undefined) return [...skills]
  const wanted = new Set(allowed)
  return skills.filter((skill) => wanted.has(skill.name))
}

export function riskyGroupsIn(tools: readonly { name: string; group: string }[], allowed: readonly string[]): string[] {
  const selected = new Set(allowed)
  const groups = new Set<string>()
  for (const tool of tools) {
    if (!selected.has(tool.name)) continue
    if (tool.group === 'edit' || tool.group === 'command' || tool.group === 'mcp') groups.add(tool.group)
  }
  return [...groups].sort()
}
