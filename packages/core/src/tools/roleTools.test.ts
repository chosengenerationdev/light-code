import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createReadRolePromptTool, createUpdateRolePromptTool } from './roleTools.js'
import type { RolePromptAccess } from './roleTools.js'
import { decideFromPolicy } from '../approval/policy.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import type { ToolExecutionContext } from './types.js'

const DEFAULTS: Record<string, string> = {
  reviewer: 'You review changes. Find what is wrong.',
  tester: 'You design tests.',
}

function access(edited: Record<string, string> = {}): RolePromptAccess & { saved: unknown[] } {
  const saved: unknown[] = []
  return {
    saved,
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
