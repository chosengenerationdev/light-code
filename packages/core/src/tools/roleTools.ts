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
  /** Creates a role the user did not have. Rejects an unusable id or a full roster. */
  create(role: {
    id: string
    name: string
    summary: string
    prompt: string
    usesTools: boolean
  }): Promise<void>
  /** How many custom roles may exist, and how many there are, so the tool can say so. */
  capacity(): { used: number; limit: number }
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

const createParams = z.object({
  id: z
    .string()
    .describe(
      'Short id the assistant will use to reach it, e.g. "security". Lowercase letters, digits ' +
        'and hyphens. It cannot be changed afterwards.',
    ),
  name: z.string().describe('What to call it in the settings panel, e.g. "Security reviewer".'),
  summary: z
    .string()
    .describe(
      'One line on what it is for. Every other specialist sees this, and the expert allocates ' +
        'from it when writing a plan — so say what it is good for, not what it is.',
    ),
  prompt: z
    .string()
    .describe(
      'Its system prompt: what it is told it is and how to answer. What it may and may not do ' +
        'is added automatically, so do not write rules about tools or permissions.',
    ),
  usesTools: z
    .boolean()
    .describe(
      'Whether it may read and search the workspace. True where the answer depends on code the ' +
        'asker cannot paste; false where the question carries everything it needs.',
    ),
})

/**
 * Inventing a specialist, from the chat.
 *
 * The same act as `update_role_prompt` and gated the same way — model-authored prose that will be
 * injected into a model advising on this repository, so a human reads it once before it exists.
 * The preview shows the whole definition rather than a diff, because there is nothing to diff
 * against and what the user is being asked to judge is the role in full.
 *
 * Deleting one is deliberately **not** offered. It takes a prompt somebody wrote and tuned with
 * it, the Agents tab already does it behind a two-click confirm, and there is no case where the
 * assistant needs to remove a role badly enough to risk getting it wrong.
 */
export function createCreateRoleTool(access: RolePromptAccess): Tool<z.infer<typeof createParams>> {
  return {
    name: 'create_role',
    // `edit`, never `always` — see the note on `update_role_prompt`.
    group: 'edit',
    description:
      'Create a new specialist role beyond the built-in ones, when the user wants a kind of ' +
      'reviewer or helper the team does not have — a security reviewer, a performance reviewer, ' +
      'one that knows a particular part of this codebase. A role is its prompt, so write that ' +
      'carefully. The user is shown the whole role and must approve it, and then assigns a model ' +
      'to it in Settings → Agents before it can answer.',
    parametersSchema: createParams,

    async preview(params) {
      const { used, limit } = access.capacity()
      return {
        kind: 'text',
        text: [
          `Create the role "${params.id.trim().toLowerCase()}" (${used + 1} of ${limit}).`,
          '',
          `Name:    ${params.name}`,
          `For:     ${params.summary}`,
          `Reads:   ${params.usesTools ? 'yes — it can read and search the workspace' : 'no — it answers from the question alone'}`,
          '',
          'What it is told:',
          '',
          params.prompt.trim(),
        ].join('\n'),
      }
    },

    async execute(params): Promise<ToolResult> {
      const id = params.id.trim().toLowerCase()
      if (access.current(id) !== undefined) {
        return {
          content:
            `There is already a "${id}" role. Change it with update_role_prompt rather than ` +
            'creating it again.',
          isError: true,
        }
      }

      try {
        await access.create({ ...params, id })
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        }
      }

      return {
        content:
          `The ${id} role exists and the user approved it. Nobody answers it yet — it needs a ` +
          'model assigned in Settings → Agents before it can be consulted. Tell the user that.',
      }
    },
  }
}
