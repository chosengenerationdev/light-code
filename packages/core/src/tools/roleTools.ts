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
  /** Everything about one role, for editing and for showing what a deletion removes. */
  details(role: string):
    | { id: string; name: string; summary: string; prompt: string; usesTools: boolean; custom: boolean }
    | undefined
  /** Removes a custom role and its assignment. Built-in roles are refused. */
  remove(role: string): Promise<void>
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
    .optional()
    .describe(
      'The complete new prompt. It replaces the current one rather than being added to it, so ' +
        'include what is staying. An empty string resets the role to its default prompt; omit it ' +
        'entirely to leave the prompt alone.',
    ),
  /*
   * Name and summary are editable for the same reason the prompt is: they are how the role
   * presents itself. The summary especially — it is the line every other specialist sees and the
   * one the expert allocates from, so a role whose summary is wrong gets used for the wrong work.
   * Only a user-defined role can change them; a built-in one is what it is.
   */
  name: z.string().optional().describe('A new display name. Custom roles only.'),
  summary: z
    .string()
    .optional()
    .describe(
      'A new one-line summary of what it is for. Custom roles only. This is what the expert ' +
        'allocates from, so it matters more than the name.',
    ),
  usesTools: z
    .boolean()
    .optional()
    .describe('Whether it may read and search the workspace. Omit to leave unchanged.'),
  reason: z
    .string()
    .optional()
    .describe('One line on what is changing and why, shown to the user above the diff.'),
})

export function createUpdateRolePromptTool(
  access: RolePromptAccess,
): Tool<z.infer<typeof updateParams>> {
  return {
    name: 'update_role',
    /*
     * `edit`, and deliberately not `always`: `decideFromPolicy` approves the `always` group
     * *before* it consults ALWAYS_ASK_TOOLS, so putting it there would silently auto-approve the
     * one thing this must always ask about. The same trap `update_plan` nearly fell into.
     */
    group: 'edit',
    description:
      'Change a specialist role: its system prompt, and for a role the user invented, its name, ' +
      'its summary, or whether it may read the workspace. Use it when the user says a specialist ' +
      'should behave differently ("make the reviewer stricter about error handling"). Read the ' +
      'role first and edit what is there rather than writing a new prompt from scratch. Only what ' +
      'you pass is changed. The user is shown a diff and must approve it, and it applies to every ' +
      'future consultation of that role.',
    parametersSchema: updateParams,

    async preview(params) {
      const role = params.role.trim().toLowerCase()
      const details = access.details(role)
      const before = describeRole(details, access.current(role) ?? '')

      const nextPrompt =
        params.prompt === undefined
          ? (access.current(role) ?? '')
          : // Empty means reset, so the diff shows what the default actually says — otherwise the
            // approval reads as "delete this prompt" rather than "go back to the built-in one".
            params.prompt.trim().length === 0
            ? (access.fallback(role) ?? '')
            : params.prompt.trim()

      const after = describeRole(
        details === undefined
          ? undefined
          : {
              ...details,
              ...(params.name !== undefined ? { name: params.name.trim() } : {}),
              ...(params.summary !== undefined ? { summary: params.summary.trim() } : {}),
              ...(params.usesTools !== undefined ? { usesTools: params.usesTools } : {}),
            },
        nextPrompt,
      )

      return {
        kind: 'diff',
        path: `the ${role} role`,
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

      const details = access.details(role)
      const changingIdentity =
        params.name !== undefined || params.summary !== undefined || params.usesTools !== undefined

      if (changingIdentity && details?.custom !== true) {
        return {
          content:
            `Only the prompt can be changed on a built-in role. "${role}" is built in, so its ` +
            'name, summary and workspace access are fixed. Create a role of your own if you need ' +
            'a different one.',
          isError: true,
        }
      }

      if (changingIdentity && details !== undefined) {
        await access.create({
          id: details.id,
          name: params.name?.trim() ?? details.name,
          summary: params.summary?.trim() ?? details.summary,
          // Carried over rather than re-sent: this path is about identity, and the prompt has its
          // own store. Passing the old one back keeps the two from disagreeing.
          prompt: details.prompt,
          usesTools: params.usesTools ?? details.usesTools,
        })
      }

      if (params.prompt !== undefined) {
        const next = params.prompt.trim()
        await access.save(role, next.length === 0 ? undefined : next)
      }

      return {
        content:
          `The ${role} is updated and the user approved it. Every consultation of that role from ` +
          'now on uses it.',
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

/**
 * One role, as the approval prompt shows it.
 *
 * The whole role rather than only the prompt, because a change can now touch the summary — which
 * is the line the expert allocates from, so altering it changes what the role gets used *for*. A
 * diff of the prompt alone would have shown nothing at all for that edit.
 */
function describeRole(
  details:
    | { name: string; summary: string; usesTools: boolean }
    | undefined,
  prompt: string,
): string {
  if (details === undefined) return prompt
  return [
    `Name:  ${details.name}`,
    `For:   ${details.summary}`,
    `Reads: ${details.usesTools ? 'yes' : 'no'}`,
    '',
    prompt,
  ].join('\n')
}

const deleteParams = z.object({
  role: z.string().describe('Which custom role to remove. Built-in roles cannot be deleted.'),
})

/**
 * Removing a role the user invented.
 *
 * This was withheld at first, on the grounds that there is no case where the assistant needs to
 * delete a role badly enough to risk getting it wrong. That was taste rather than a safety
 * argument: the act is gated exactly like creating one, the approval shows the whole role
 * including the prompt that would be lost, and refusing it only means the user goes and does the
 * same thing by hand. Asked for, and the objection did not survive being written down.
 *
 * Built-in roles are refused rather than hidden — "delete the reviewer" is a reasonable thing to
 * try, and being told why beats the call quietly doing nothing.
 */
export function createDeleteRoleTool(access: RolePromptAccess): Tool<z.infer<typeof deleteParams>> {
  return {
    name: 'delete_role',
    group: 'edit',
    description:
      'Remove a role the user invented, along with whatever model was assigned to it. Built-in ' +
      'roles cannot be removed. The user is shown the role, including its prompt, and must ' +
      'approve. Nothing else refers to it afterwards, so any plan step naming it should be ' +
      'revised in the same turn.',
    parametersSchema: deleteParams,

    async preview(params) {
      const role = params.role.trim().toLowerCase()
      const details = access.details(role)
      return {
        kind: 'text',
        text:
          details === undefined
            ? `There is no "${role}" role to delete.`
            : [
                `Delete the "${details.id}" role and its assignment.`,
                '',
                describeRole(details, details.prompt),
                '',
                'The prompt above is removed with it.',
              ].join('\n'),
      }
    },

    async execute(params): Promise<ToolResult> {
      const role = params.role.trim().toLowerCase()
      const details = access.details(role)
      if (details === undefined) {
        return { content: `There is no "${role}" role.`, isError: true }
      }
      if (!details.custom) {
        return {
          content:
            `"${role}" is one of the built-in roles and cannot be deleted. Leave it unassigned ` +
            'if it should not be used.',
          isError: true,
        }
      }

      await access.remove(role)
      return { content: `The ${role} role is gone, and so is its assignment.` }
    },
  }
}
