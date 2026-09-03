import nodePath from 'node:path'
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '../approval/types.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import { ALWAYS_AVAILABLE_TO_SCHEDULES, type Schedule } from './types.js'

/**
 * What an unattended run is allowed to do.
 *
 * ## The registry is the boundary, not the approval gate
 *
 * A scheduled run has nobody to approve anything. The tempting shape — run normally but
 * auto-approve — is precisely the hole §8 exists to prevent, and one prompt injection turns it
 * into arbitrary execution.
 *
 * So the restriction is applied by **building a smaller registry**: a tool the schedule did not
 * name is not registered, which means it never reaches the system prompt and the model is never
 * told it exists. Then the loop's own mode check refuses it a second time if a stale transcript
 * references it. The same layering §11 uses for disabled MCP tools, for the same reason —
 * withholding a capability beats refusing it at call time.
 *
 * `filterToolsForSchedule` is exported and tested directly, because "a scheduled run cannot use
 * a tool outside its allowlist" is the security property of this whole phase and the plan asks
 * for it to be verified by a test rather than by inspection.
 */

/**
 * Tools a schedule may never be granted, however deliberately it is ticked.
 *
 * Editing files unattended is a legitimate thing to authorise in advance: the user chose the
 * tools, in the open, for one named job, and the allowlist *is* their approval. Writing a
 * **Python tool or a skill** is not the same act. Those install model-authored code that later
 * runs, and prose later injected into the assistant's own context — and §13 requires approval
 * that shows the full source, which is exactly what cannot happen with nobody watching.
 *
 * The distinction is between authorising a *change* and authorising a *capability*. A checkbox
 * ticked once cannot honestly mean "write and install any code you like, unattended, forever",
 * so the checkbox is not offered.
 *
 * This mirrors `ALWAYS_ASK_TOOLS` in `approval/policy.ts`, which covers the interactive path.
 * It has to be repeated here because a scheduled run **replaces** the approval gate rather than
 * wrapping it, so the policy gate — and that list — never runs.
 */
export const NEVER_AVAILABLE_TO_SCHEDULES: readonly string[] = [
  'create_python_tool',
  'update_python_tool',
  'delete_python_tool',
  'write_skill',
  'delete_skill',
  // Same reasoning, and sharper unattended: installing a macro is authorising a capability, and
  // section 13 requires approval showing the source, which cannot happen with nobody there.
  'excel_write_macro',
  // And running one: unattended execution of arbitrary VBA, with nobody to read the source.
  'excel_run_macro',
]

/**
 * The tools a schedule may use: exactly those named, plus the control tools.
 *
 * An **allowlist**, so installing a new MCP server never silently widens an existing schedule.
 * `ask_followup_question` is dropped even if named — there is nobody to answer it, and a run
 * that asked would wait for a reply that never arrives.
 *
 * Enforced in the *registry*, so a forbidden tool is never offered rather than offered and
 * refused: the model cannot spend a turn working around something it was never given.
 */
/**
 * Whether a schedule belongs to the project that is open.
 *
 * Absent `workspaceRoot` means "any", for schedules written before schedules had one. Compared
 * the same way every other path in this codebase is: resolved, and case-folded on Windows, where
 * the same folder arrives spelled two ways depending on how the window was opened.
 */
export function scheduleAppliesHere(
  schedule: { workspaceRoot?: string | undefined },
  workspaceRoot: string | undefined,
): boolean {
  if (schedule.workspaceRoot === undefined) return true
  if (workspaceRoot === undefined) return false
  const normalise = (value: string): string => {
    const resolved = nodePath.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalise(schedule.workspaceRoot) === normalise(workspaceRoot)
}

export function filterToolsForSchedule(all: readonly Tool[], schedule: Pick<Schedule, 'allowedTools'>): Tool[] {
  const named = new Set(schedule.allowedTools)
  const always = new Set<string>(ALWAYS_AVAILABLE_TO_SCHEDULES)

  const never = new Set(NEVER_AVAILABLE_TO_SCHEDULES)

  return all.filter((tool) => {
    // Both ask a person something. Nobody is there, so a run that called one would wait for an
    // answer that never arrives — dropped even if the allowlist names them.
    if (tool.name === 'ask_followup_question' || tool.name === 'ask_user_form') return false
    if (never.has(tool.name)) return false
    if (always.has(tool.name)) return true
    return named.has(tool.name)
  })
}

export function registryForSchedule(all: readonly Tool[], schedule: Pick<Schedule, 'allowedTools'>): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of filterToolsForSchedule(all, schedule)) registry.register(tool)
  return registry
}

/**
 * Approves what the schedule named, and nothing else.
 *
 * A second line of defence rather than the primary one: a tool outside the allowlist is not
 * registered at all, so this should never see one. If it somehow does — a future refactor
 * registering tools by another route — the run must stop rather than proceed unsupervised.
 *
 * It denies rather than throwing, because a denial is fed back to the model as a tool result
 * and the run continues to a sensible conclusion, whereas an exception would abort the task
 * mid-way and leave a half-finished session with no explanation in it.
 */
export class ScheduledApprovalGate implements ApprovalGate {
  public readonly refused: string[] = []

  constructor(private readonly schedule: Pick<Schedule, 'allowedTools'>) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    // Repeated here rather than trusted to the registry: this class exists as the second line
    // of defence, and the thing most worth defending twice is the one that installs code.
    if (NEVER_AVAILABLE_TO_SCHEDULES.includes(request.toolName)) {
      this.refused.push(request.toolName)
      return 'deny'
    }

    const permitted =
      this.schedule.allowedTools.includes(request.toolName) ||
      (ALWAYS_AVAILABLE_TO_SCHEDULES as readonly string[]).includes(request.toolName)

    if (permitted) return 'approve'
    this.refused.push(request.toolName)
    return 'deny'
  }
}

/**
 * The prompt an unattended run is given, on top of the ordinary system prompt.
 *
 * Two things it must know and cannot work out: that nobody will answer a question, and that
 * its tools are deliberately narrowed. Without the second it reads a missing tool as a broken
 * installation and spends the run trying to work around it.
 */
export function scheduledRunGuidance(schedule: Schedule, toolNames: readonly string[]): string {
  return [
    '# This is a scheduled run',
    '',
    `You are running unattended as the schedule "${schedule.name}". Nobody is watching, and`,
    'nobody can answer a question — do not ask one, and do not wait for confirmation.',
    '',
    toolNames.length > 0
      ? `You may use only these tools: ${toolNames.join(', ')}.`
      : 'You have no tools beyond finishing: answer from what you are given.',
    'That is deliberate, not a fault. Anything else was withheld for this run because it',
    'happens without supervision. If the task genuinely cannot be done within them, say so',
    'in your final answer rather than attempting a workaround.',
    '',
    'Finish with attempt_completion. Keep the answer short: it will be read later, out of',
    'context, possibly as a notification.',
  ].join('\n')
}
