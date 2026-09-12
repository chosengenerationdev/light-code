import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createCreateRoleTool,
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
): RolePromptAccess & { saved: unknown[]; created: { id: string }[] } {
  const saved: unknown[] = []
  const created: { id: string }[] = []
  return {
    saved,
    created,
    list: () =>
      Object.keys(DEFAULTS).map((role) => ({
        role,
        name: role,
        assigned: true,
        edited: edited[role] !== undefined,
      })),
    current: (role) => edited[role] ?? DEFAULTS[role],
    fallback: (role) => DEFAULTS[role],
    save: async (role, prompt) => {
      saved.push({ role, prompt })
    },
    create: async (role) => {
      if (created.length >= 1) throw new Error('The limit is 1 custom role.')
      created.push(role)
    },
    capacity: () => ({ used: created.length, limit: 1 }),
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
          toolName: 'update_role_prompt',
          group: tool.group,
          preview: { kind: 'text', text: '' },
        },
        {
          autoApprove: { read: true, edit: true, command: true, mcp: true },
          allowedTools: ['update_role_prompt'],
          allowedCommands: [],
        },
      ),
    ).toBeUndefined()
  })

  it('is never available to an unattended run', () => {
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('update_role_prompt')
  })

  it('shows a diff of the prompt that stands against the one proposed', async () => {
    const tool = createUpdateRolePromptTool(access({ reviewer: 'Be brutal.' }))
    const preview = await tool.preview?.(
      { role: 'reviewer', prompt: 'Be brutal. Especially about error handling.', reason: 'stricter' },
      NO_CONTEXT,
    )
    expect(preview).toMatchObject({
      kind: 'diff',
      before: 'Be brutal.',
      after: 'Be brutal. Especially about error handling.',
      note: 'stricter',
    })
  })

  /*
   * An empty prompt means reset. The diff has to show the *default* as the outcome, or the
   * approval reads as "delete this role's prompt" — which is a different and alarming act.
   */
  it('previews a reset as a return to the default, not as deletion', async () => {
    const tool = createUpdateRolePromptTool(access({ reviewer: 'Be brutal.' }))
    const preview = await tool.preview?.({ role: 'reviewer', prompt: '   ' }, NO_CONTEXT)
    expect(preview).toMatchObject({ before: 'Be brutal.', after: DEFAULTS.reviewer })
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

  /*
   * Deleting is deliberately not offered to the model: it takes a prompt somebody wrote and tuned
   * with it, and the tab already does it behind a two-click confirm.
   */
  it('offers no way to delete one', () => {
    const source = readFileSync(fileURLToPath(new URL('./roleTools.ts', import.meta.url)), 'utf8')
    expect(source).not.toContain('delete_role')
  })
})
