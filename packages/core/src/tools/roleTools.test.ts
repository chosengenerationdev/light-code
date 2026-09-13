import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createCreateRoleTool,
  createDeleteRoleTool,
  createReadRolePromptTool,
  createUpdateRolePromptTool,
} from './roleTools.js'
import type { RolePromptAccess } from './roleTools.js'
import { decideFromPolicy } from '../approval/policy.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import type { ToolExecutionContext } from './types.js'

const DEFAULTS: Record<string, string> = {
  reviewer: 'You review changes. Find what is wrong.',
  tester: 'You design tests.',
}

function access(
  edited: Record<string, string> = {},
): RolePromptAccess & { saved: unknown[]; created: { id: string }[]; removed: string[] } {
  const saved: unknown[] = []
  const created: { id: string }[] = []
  const removed: string[] = []
  return {
    saved,
    created,
    removed,
    list: () =>
      Object.keys(DEFAULTS).map((role) => ({
        role,
        name: role,
        assigned: true,
        edited: edited[role] !== undefined,
      })),
    current: (role) =>
      edited[role] ??
      DEFAULTS[role] ??
      // A created role has a prompt too — without this the fixture reported every custom role as
      // not existing, and the tool refused an edit for a reason the real host does not have.
      (created.find((candidate) => candidate.id === role) as { prompt?: string } | undefined)?.prompt,
    fallback: (role) => DEFAULTS[role],
    save: async (role, prompt) => {
      saved.push({ role, prompt })
    },
    create: async (role) => {
      // Mirrors the host: an id that already exists is *replaced*, and only a genuinely new one
      // meets the cap. The first version of this fixture refused both, which failed an edit for a
      // reason the real code does not have — the fixture was wrong, not the tool.
      const at = created.findIndex((candidate) => candidate.id === role.id)
      if (at !== -1) {
        created[at] = role
        return
      }
      if (created.length >= 1) throw new Error('The limit is 1 custom role.')
      created.push(role)
    },
    capacity: () => ({ used: created.length, limit: 1 }),
    details: (role) => {
      const custom = created.find((candidate) => candidate.id === role) as
        | { id: string; name: string; summary: string; prompt: string; usesTools: boolean }
        | undefined
      if (custom !== undefined) {
        // The override, exactly as the host resolves it: an edit is stored separately from the
        // definition, and `prompt` is what the role actually runs on. Without modelling that, a
        // test about preserving the original passes whatever the code does.
        const edits = saved as { role: string; prompt?: string }[]
        const override = [...edits].reverse().find((entry) => entry.role === role)
        return {
          ...custom,
          prompt: override?.prompt ?? custom.prompt,
          originalPrompt: custom.prompt,
          custom: true,
        }
      }
      const builtIn = DEFAULTS[role]
      return builtIn === undefined
        ? undefined
        : {
            id: role,
            name: role,
            summary: `the ${role}`,
            prompt: edited[role] ?? builtIn,
            originalPrompt: builtIn,
            usesTools: true,
            custom: false,
          }
    },
    remove: async (role) => {
      removed.push(role)
    },
  }
}

const NO_CONTEXT = {} as unknown as ToolExecutionContext

describe('reading a role prompt', () => {
  it('returns the prompt in force, and says whose it is', async () => {
    const tool = createReadRolePromptTool(access({ reviewer: 'Be brutal.' }))
    const result = await tool.execute({ role: 'reviewer' }, NO_CONTEXT)
    expect(String(result.content)).toContain('Be brutal.')
    expect(String(result.content)).toContain('edited by the user')
  })

  it('says when a prompt is still the default', async () => {
    const tool = createReadRolePromptTool(access())
    const result = await tool.execute({ role: 'reviewer' }, NO_CONTEXT)
    expect(String(result.content)).toContain('the default')
  })

  it('lists the roles when asked for none', async () => {
    const tool = createReadRolePromptTool(access({ reviewer: 'x' }))
    const result = await tool.execute({}, NO_CONTEXT)
    expect(String(result.content)).toContain('reviewer')
    expect(String(result.content)).toContain('prompt edited')
    expect(String(result.content)).toContain('default prompt')
  })

  it('names the roles that exist when given one that does not', async () => {
    const tool = createReadRolePromptTool(access())
    const result = await tool.execute({ role: 'architect' }, NO_CONTEXT)
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('reviewer, tester')
  })
})

describe('changing a role prompt', () => {
  /*
   * The same trap `update_plan` nearly fell into: `decideFromPolicy` approves the `always` group
   * *before* it consults ALWAYS_ASK_TOOLS, so grouping this there would silently auto-approve the
   * one thing it must always ask about. And the failure would be quiet — a reviewer whose prompt
   * was softened does not error, it approves things.
   */
  it('is never auto-approved, whatever is switched on', () => {
    const tool = createUpdateRolePromptTool(access())
    expect(tool.group).not.toBe('always')
    expect(
      decideFromPolicy(
        {
          id: 'probe',
          toolName: 'update_role',
          group: tool.group,
          preview: { kind: 'text', text: '' },
        },
        {
          autoApprove: { read: true, edit: true, command: true, mcp: true },
          allowedTools: ['update_role'],
          allowedCommands: [],
        },
      ),
    ).toBeUndefined()
  })

  it('is never available to an unattended run', () => {
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('update_role')
  })

  it('shows a diff of the prompt that stands against the one proposed', async () => {
    const tool = createUpdateRolePromptTool(access({ reviewer: 'Be brutal.' }))
    const preview = await tool.preview?.(
      { role: 'reviewer', prompt: 'Be brutal. Especially about error handling.', reason: 'stricter' },
      NO_CONTEXT,
    )
    expect(preview).toMatchObject({ kind: 'diff', note: 'stricter' })
    const diff = preview as { before: string; after: string }
    expect(diff.before).toContain('Be brutal.')
    expect(diff.after).toContain('Be brutal. Especially about error handling.')
  })

  /*
   * An empty prompt means reset. The diff has to show the *default* as the outcome, or the
   * approval reads as "delete this role's prompt" — which is a different and alarming act.
   */
  it('previews a reset as a return to the default, not as deletion', async () => {
    const tool = createUpdateRolePromptTool(access({ reviewer: 'Be brutal.' }))
    const preview = await tool.preview?.({ role: 'reviewer', prompt: '   ' }, NO_CONTEXT)
    const diff = preview as { before: string; after: string }
    expect(diff.before).toContain('Be brutal.')
    expect(diff.after).toContain(DEFAULTS.reviewer ?? '')
  })

  it('clears the edit rather than storing an empty one', async () => {
    const store = access({ reviewer: 'Be brutal.' })
    const tool = createUpdateRolePromptTool(store)
    await tool.execute({ role: 'reviewer', prompt: '' }, NO_CONTEXT)
    expect(store.saved).toEqual([{ role: 'reviewer', prompt: undefined }])
  })

  it('refuses a role that does not exist', async () => {
    const store = access()
    const tool = createUpdateRolePromptTool(store)
    const result = await tool.execute({ role: 'architect', prompt: 'x' }, NO_CONTEXT)
    expect(result.isError).toBe(true)
    expect(store.saved).toEqual([])
  })
})

describe('the wiring', () => {
  const bridge = readFileSync(fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')

  it('registers both tools', () => {
    expect(bridge).toContain('createReadRolePromptTool(rolePromptAccess)')
    expect(bridge).toContain('createUpdateRolePromptTool(rolePromptAccess)')
    expect(bridge).toContain('createDeleteRoleTool(rolePromptAccess)')
  })

  /*
   * Through `saveAgents`, the same function the Agents tab uses — which is what brings the config
   * reload and the panel repost with it. A second write path would leave the tab showing the old
   * prompt until something else happened to refresh it.
   */
  it('writes through the same path the settings panel uses', () => {
    const accessAt = bridge.indexOf('const rolePromptAccess')
    const block = bridge.slice(accessAt, accessAt + 2000)
    expect(block).toContain('await saveAgents(')
  })
})

describe('inventing a role', () => {
  it('shows the whole role, because there is nothing to diff against', async () => {
    const tool = createCreateRoleTool(access())
    const preview = await tool.preview?.(
      {
        id: 'security',
        name: 'Security reviewer',
        summary: 'Threat model and attack surface',
        prompt: 'You review changes for security.',
        usesTools: true,
      },
      NO_CONTEXT,
    )
    const text = preview?.kind === 'text' ? preview.text : ''
    expect(text).toContain('Security reviewer')
    expect(text).toContain('Threat model and attack surface')
    expect(text).toContain('You review changes for security.')
    // What it can do is part of what is being approved, not a detail.
    expect(text).toContain('it can read and search the workspace')
    expect(text).toContain('1 of 1')
  })

  it('creates it and says it still needs a model', async () => {
    const store = access()
    const tool = createCreateRoleTool(store)
    const result = await tool.execute(
      { id: ' Security ', name: 'Security reviewer', summary: 's', prompt: 'p', usesTools: false },
      NO_CONTEXT,
    )
    // Normalised here as well as in the host, so the id the model typed cannot differ from the
    // one that gets stored by a stray capital.
    expect(store.created).toEqual([
      { id: 'security', name: 'Security reviewer', summary: 's', prompt: 'p', usesTools: false },
    ])
    expect(String(result.content)).toContain('needs a model assigned')
  })

  it('refuses a role that already exists, and points at the other tool', async () => {
    const store = access()
    const tool = createCreateRoleTool(store)
    const result = await tool.execute(
      { id: 'reviewer', name: 'x', summary: 's', prompt: 'p', usesTools: true },
      NO_CONTEXT,
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('update_role_prompt')
    expect(store.created).toEqual([])
  })

  /*
   * The cap is enforced where the tab enforces it, so the tool reports the same sentence rather
   * than carrying its own copy of the rule. A second limit check is a second thing to get wrong.
   */
  it('reports the host refusing it rather than throwing', async () => {
    const store = access()
    const tool = createCreateRoleTool(store)
    await tool.execute({ id: 'a', name: 'a', summary: '', prompt: '', usesTools: true }, NO_CONTEXT)
    const result = await tool.execute(
      { id: 'b', name: 'b', summary: '', prompt: '', usesTools: true },
      NO_CONTEXT,
    )
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('limit is 1')
  })

  it('always asks, and is never available to a schedule', () => {
    expect(createCreateRoleTool(access()).group).not.toBe('always')
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('create_role')
  })

})

describe('editing and removing a role', () => {
  it('changes a custom role\'s name and summary', async () => {
    const store = access()
    await store.create({
      id: 'db',
      name: 'DB reviewer',
      summary: 'SQL',
      prompt: 'You review SQL.',
      usesTools: true,
    })

    const tool = createUpdateRolePromptTool(store)
    const result = await tool.execute(
      { role: 'db', summary: 'SQL, migrations and indexes' },
      NO_CONTEXT,
    )
    expect(result.isError).toBeUndefined()
    expect(store.created.at(-1)).toMatchObject({
      id: 'db',
      name: 'DB reviewer',
      summary: 'SQL, migrations and indexes',
      // The prompt is carried over rather than re-sent, so an identity edit cannot blank it.
      prompt: 'You review SQL.',
    })
  })

  /*
   * A built-in role is what it is. Renaming the reviewer would leave a role whose name says one
   * thing and whose prompt says another, and the expert allocates from the summary.
   */
  /*
   * The failure this guards: rename a role whose prompt had been edited, and the edit was written
   * into the *definition* — so "reset to default" afterwards handed back the edit, with the text
   * the role was created with gone for good and nothing reporting a loss.
   *
   * An edit and the original live in separate stores precisely so that one can be undone. The
   * identity path must not collapse them.
   */
  it('keeps the original prompt when a role with an edited one is renamed', async () => {
    const store = access()
    await store.create({
      id: 'db',
      name: 'DB reviewer',
      summary: 'SQL',
      prompt: 'ORIGINAL',
      usesTools: true,
    })

    const tool = createUpdateRolePromptTool(store)
    // an edit on top, then a rename
    await tool.execute({ role: 'db', prompt: 'EDITED' }, NO_CONTEXT)
    await tool.execute({ role: 'db', name: 'Database reviewer' }, NO_CONTEXT)

    expect(store.created.at(-1)).toMatchObject({
      name: 'Database reviewer',
      prompt: 'ORIGINAL',
    })
  })

  it('refuses to rename a built-in role, and says why', async () => {
    const store = access()
    const tool = createUpdateRolePromptTool(store)
    const result = await tool.execute({ role: 'reviewer', name: 'Nitpicker' }, NO_CONTEXT)
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('built in')
  })

  it('leaves the prompt alone when none was passed', async () => {
    const store = access({ reviewer: 'Be brutal.' })
    const tool = createUpdateRolePromptTool(store)
    await tool.execute({ role: 'reviewer' }, NO_CONTEXT)
    expect(store.saved).toEqual([])
  })

  it('shows the whole role before deleting it, including the prompt that goes', async () => {
    const store = access()
    await store.create({
      id: 'db',
      name: 'DB reviewer',
      summary: 'SQL',
      prompt: 'You review SQL.',
      usesTools: true,
    })

    const tool = createDeleteRoleTool(store)
    const preview = await tool.preview?.({ role: 'db' }, NO_CONTEXT)
    const text = preview?.kind === 'text' ? preview.text : ''
    expect(text).toContain('DB reviewer')
    expect(text).toContain('You review SQL.')
    expect(text).toContain('removed with it')

    await tool.execute({ role: 'db' }, NO_CONTEXT)
    expect(store.removed).toEqual(['db'])
  })

  it('refuses to delete a built-in role', async () => {
    const store = access()
    const tool = createDeleteRoleTool(store)
    const result = await tool.execute({ role: 'reviewer' }, NO_CONTEXT)
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('cannot be deleted')
    expect(store.removed).toEqual([])
  })

  it('always asks before deleting, and never does it unattended', () => {
    expect(createDeleteRoleTool(access()).group).not.toBe('always')
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('delete_role')
  })
})
