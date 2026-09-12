import { z } from 'zod'
import { PLAN_LIMIT } from '../agent/plan.js'
import type { Tool, ToolResult } from './types.js'

/**
 * The two things the assistant may do with the plan: propose a new one, and say where it is.
 *
 * ## Why proposing is approval-gated and reporting is not
 *
 * They look similar and are opposites. A plan exists to hold the assistant to work the user
 * agreed — `agent/plan.ts` says in as many words that a plan the user set and a plan the model
 * preferred are different things, and only one of them was agreed. A model that could rewrite its
 * own plan silently would defeat the entire feature, and it would do so in the most expensive
 * way: the panel and the prompt would both look right, because both would be reading the new
 * plan. So `update_plan` goes through the ordinary approval gate, showing a **diff of the plan
 * the user has against the plan being proposed** — invariant 8, applied to the constraints rather
 * than to the code.
 *
 * `plan_progress` claims nothing the user has to authorise. It moves a marker in a panel, and the
 * worst a wrong call does is mis-colour a row that the transcript beside it contradicts.
 *
 * ## Why `update_plan` is not in the `always` group
 *
 * It would have been the natural-looking choice — it is not a workspace edit. But
 * `decideFromPolicy` answers `approve` for the `always` group **before** it consults
 * `ALWAYS_ASK_TOOLS`, so grouping it there would have quietly auto-approved the very permission
 * this exists to ask for. `edit` is also the honest group in a second way: in a read-only mode the
 * assistant should no more rewrite its instructions than rewrite a file.
 */

export interface PlanAccess {
  /** The saved plan, as the user has it. */
  current(): string | undefined
  /** Replaces it. Called only after the user has approved the diff. */
  save(next: string): Promise<void>
  /** Moves one checkpoint by the number the plan guidance gave the model. */
  mark(
    index: number,
    status: 'active' | 'done',
  ): Promise<{ ok: true; summary: string } | { ok: false; reason: string }>
}

const updateParams = z.object({
  plan: z
    .string()
    .describe(
      'The complete new plan, as numbered steps. This replaces the whole plan rather than ' +
        'being added to it, so include the steps that are staying.',
    ),
  reason: z
    .string()
    .optional()
    .describe('One line on why the plan should change, shown to the user with the diff.'),
})

export function createUpdatePlanTool(access: PlanAccess): Tool<z.infer<typeof updateParams>> {
  return {
    name: 'update_plan',
    group: 'edit',
    description:
      'Propose a new plan for this conversation, replacing the current one. The user is shown ' +
      'a diff and must approve it before anything changes. Use this after working out a plan — ' +
      'for example one a specialist drafted — rather than carrying it only in the conversation, ' +
      'which is forgotten as the chat grows. Give the whole plan as numbered steps; each step ' +
      'becomes a checkpoint the user can watch you complete.',
    parametersSchema: updateParams,

    async preview(params) {
      const before = access.current() ?? ''
      return {
        kind: 'diff',
        // Not a file. The approval UI labels the diff with this, and naming it for what it is
        // beats a made-up path that implies something on disk is about to change.
        path: 'the plan for this conversation',
        before,
        after: params.plan.slice(0, PLAN_LIMIT).trim(),
        ...(params.reason !== undefined && params.reason.trim().length > 0
          ? { note: params.reason.trim() }
          : {}),
      }
    },

    async execute(params): Promise<ToolResult> {
      const next = params.plan.slice(0, PLAN_LIMIT).trim()
      if (next.length === 0) {
        return { content: 'A plan cannot be empty. To remove the plan, ask the user to clear it.' }
      }

      await access.save(next)
      return {
        content:
          'The plan is updated and the user approved it. It is now in front of you for the rest ' +
          'of this conversation, and its steps are the checkpoints to report against.',
      }
    },
  }
}

const progressParams = z.object({
  checkpoint: z
    .number()
    .int()
    .describe('The step number, as numbered in the plan you were given.'),
  status: z
    .enum(['active', 'done'])
    .describe('`active` when you start the step, `done` when it is genuinely finished.'),
})

export function createPlanProgressTool(access: PlanAccess): Tool<z.infer<typeof progressParams>> {
  return {
    name: 'plan_progress',
    /*
     * Control flow, not an action: it records where you are and touches nothing else. Gating it
     * would mean an approval prompt between every step of every planned task, which nobody would
     * keep switched on for long.
     */
    group: 'always',
    description:
      'Say which step of the plan you are on. Call it with `active` when you start a step and ' +
      '`done` when it is finished, so the user can watch progress without reading the whole ' +
      'transcript. Mark `done` only when the step is actually complete — a step you gave up on ' +
      'or half did should be reported in your reply instead.',
    parametersSchema: progressParams,

    async execute(params): Promise<ToolResult> {
      const outcome = await access.mark(params.checkpoint, params.status)
      if (!outcome.ok) return { content: outcome.reason, isError: true }
      return { content: outcome.summary }
    },
  }
}
