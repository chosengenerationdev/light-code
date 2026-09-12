import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

/**
 * Changing what a specialist *is*, from the chat.
 *
 * Requested directly: "make the reviewer stricter about error handling" should be something you
 * say rather than something you go and edit. A role is its prompt, so this is the shortest path
 * from noticing a specialist is answering the wrong way to it answering the right way.
 *
 * ## Why updating one is approval-gated, and reading one is not
 *
 * A role prompt is **prose injected into a model that is then asked to advise on this
 * repository's own code**. That sentence is why `agents` is user-scope only (invariant 5) — a
 * hostile repo able to write it could tell the reviewer what to approve, and every review
 * afterwards would look normal. Model-authored text with that property is exactly what
 * `write_skill` is, and it gets the same rule: `ALWAYS_ASK_TOOLS`, never auto-approved by a
 * category toggle, never available to a scheduled run, and an approval showing a **diff** of the
 * prompt that stands against the one proposed (invariant 8).
 *
 * The failure being guarded is quiet, not loud. A reviewer whose prompt has been softened does
 * not error — it approves things, in the same tone as before.
 *
 * ## Why there is a read tool at all
 *
 * Without it the assistant rewrites blind: asked to make the reviewer stricter it would produce a
 * whole new prompt from its own idea of what a reviewer is, discarding whatever you had written.
 * Reading first makes the change an *edit* rather than a replacement, and it costs a `read`-group
 * tool that changes nothing.
 */

export interface RolePromptAccess {
  /** Every role that exists here, built-in or custom, with whether anybody answers it. */
  list(): { role: string; name: string; assigned: boolean; edited: boolean }[]
  /** The prompt in force for a role: the user's edit where there is one, else the default. */
  current(role: string): string | undefined
  /** The default, so a caller can say what resetting would restore. */
  fallback(role: string): string | undefined
  /** Stores an edited prompt, or clears the edit when given undefined. */
  save(role: string, prompt: string | undefined): Promise<void>
}

const readParams = z.object({
  role: z
    .string()
    .describe('Which role to read — one of the roles configured here. Omit to list them all.')
    .optional(),
})

export function createReadRolePromptTool(
  access: RolePromptAccess,
): Tool<z.infer<typeof readParams>> {
  return {
    name: 'read_role_prompt',
    group: 'read',
    description:
      "Read a specialist role's current system prompt — what it is told it is. Call this before " +
      'changing one, so the change is an edit to what the user wrote rather than a replacement ' +
      'for it. With no role, lists the roles that exist here.',
    parametersSchema: readParams,

    async execute(params): Promise<ToolResult> {
      const roles = access.list()
      if (params.role === undefined) {
        if (roles.length === 0) return { content: 'No roles are configured.' }
        return {
          content: roles
            .map(
              (entry) =>
                `- ${entry.role} (${entry.name})` +
                (entry.assigned ? '' : ' — nobody assigned') +
                (entry.edited ? ' — prompt edited' : ' — default prompt'),
            )
            .join('\n'),
        }
      }

      const role = params.role.trim().toLowerCase()
      const prompt = access.current(role)
      if (prompt === undefined) {
        return {
          content:
            `There is no "${role}" role. The roles here are: ` +
            `${roles.map((entry) => entry.role).join(', ')}.`,
          isError: true,
        }
      }

      const edited = roles.find((entry) => entry.role === role)?.edited === true
      return {
        content:
          `The ${role}'s prompt${edited ? ' (edited by the user)' : ' (the default)'}:\n\n${prompt}`,
      }
    },
  }
}

const updateParams = z.object({
  role: z.string().describe('Which role to change.'),
  prompt: z
    .string()
    .describe(
      'The complete new prompt. It replaces the current one rather than being added to it, so ' +
        'include what is staying. Leave empty to reset the role to its default prompt.',
    ),
  reason: z
    .string()
    .optional()
    .describe('One line on what is changing and why, shown to the user above the diff.'),
})

export function createUpdateRolePromptTool(
  access: RolePromptAccess,
): Tool<z.infer<typeof updateParams>> {
  return {
    name: 'update_role_prompt',
    /*
     * `edit`, and deliberately not `always`: `decideFromPolicy` approves the `always` group
     * *before* it consults ALWAYS_ASK_TOOLS, so putting it there would silently auto-approve the
     * one thing this must always ask about. The same trap `update_plan` nearly fell into.
     */
    group: 'edit',
    description:
      "Change a specialist role's system prompt — what it is told it is, and how it should " +
      'answer. Use it when the user says a specialist should behave differently ("make the ' +
      'reviewer stricter about error handling"). Read the current prompt first and edit it, ' +
      'rather than writing a new one from scratch. The user is shown a diff and must approve it. ' +
      'This changes every future consultation of that role, not just the next one.',
    parametersSchema: updateParams,

    async preview(params) {
      const role = params.role.trim().toLowerCase()
      const before = access.current(role) ?? ''
      const next = params.prompt.trim()
      // Empty means reset, so the diff has to show what the default actually says — otherwise
      // the approval reads as "delete this prompt" rather than "go back to the built-in one".
      const after = next.length === 0 ? (access.fallback(role) ?? '') : next

      return {
        kind: 'diff',
        path: `the ${role} role's prompt`,
        before,
        after,
        ...(params.reason !== undefined && params.reason.trim().length > 0
          ? { note: params.reason.trim() }
          : {}),
      }
    },

    async execute(params): Promise<ToolResult> {
      const role = params.role.trim().toLowerCase()
      if (access.current(role) === undefined) {
        return {
          content:
            `There is no "${role}" role. The roles here are: ` +
            `${access
              .list()
              .map((entry) => entry.role)
              .join(', ')}.`,
          isError: true,
        }
      }

      const next = params.prompt.trim()
      await access.save(role, next.length === 0 ? undefined : next)

      return {
        content:
          next.length === 0
            ? `The ${role} is back to its default prompt. This applies from the next consultation.`
            : `The ${role}'s prompt is updated and the user approved it. Every consultation of ` +
              'that role from now on uses it.',
      }
    },
  }
}
