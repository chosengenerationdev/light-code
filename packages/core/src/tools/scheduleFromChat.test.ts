import { describe, expect, it } from 'vitest'

import {
  createScheduleFromChatTool,
  scheduleFormFields,
  triggerFromAnswers,
  type ScheduleProposal,
} from './scheduleFromChat.js'
import type { ToolExecutionContext, ToolPreview } from './types.js'

/** Every preview this tool produces is text; narrowed once rather than at each assertion. */
function previewText(preview: ToolPreview | undefined): string {
  return preview !== undefined && preview.kind === 'text' ? preview.text : ''
}

/**
 * Creating a scheduled job from the chat.
 *
 * The property that matters most is the one §6b states: **a submitted form is input, never
 * permission.** Here the form collects a list of granted capabilities, so reading the ticked
 * boxes as consent would let a persuasively-described form grant a 3am job `execute_command`.
 * The approval gate has to see the resulting schedule, computed from what would be written.
 */

const tools = [
  { name: 'read_file', description: 'read a file' },
  { name: 'execute_command', description: 'run a command' },
]

function tool(overrides: {
  requestForm?: (fields: unknown[], title: string) => Promise<Record<string, unknown> | undefined>
  create?: (proposal: ScheduleProposal) => Promise<{ id: string; nextRunAt?: number }>
}) {
  const created: ScheduleProposal[] = []
  const built = createScheduleFromChatTool({
    schedulableTools: () => tools,
    ...(overrides.requestForm !== undefined ? { requestForm: overrides.requestForm as never } : {}),
    create:
      overrides.create ??
      (async (proposal) => {
        created.push(proposal)
        return { id: 'job-1' }
      }),
  })
  return { built, created }
}

const params = { name: 'Morning check', prompt: 'Report any alerts overnight.' }

describe('the form', () => {
  it('offers every tool the host says a schedule may use', () => {
    const fields = scheduleFormFields(tools)
    const toolField = fields.find((field) => field.name === 'tools')

    expect(toolField?.type).toBe('multichoice')
    expect(toolField?.options?.map((option) => option.value)).toEqual(['read_file', 'execute_command'])
  })

  /** Nothing ticked is a real choice, and the field says so rather than leaving it to be noticed. */
  it('does not require a tool to be chosen', () => {
    const toolField = scheduleFormFields(tools).find((field) => field.name === 'tools')
    expect(toolField?.required).toBe(false)
    expect(toolField?.description).toContain('cannot touch anything')
  })
})

describe('turning answers into a cadence', () => {
  it('reads a daily time', () => {
    expect(triggerFromAnswers({ cadence: 'daily', time: '07:30' })).toEqual({
      kind: 'daily',
      hour: 7,
      minute: 30,
    })
  })

  /** Five explicit days: obviously right, and the sort of thing that is quietly wrong. */
  it('expands weekdays to Monday through Friday', () => {
    expect(triggerFromAnswers({ cadence: 'weekdays', time: '06:00' })).toEqual({
      kind: 'weekly',
      days: [1, 2, 3, 4, 5],
      hour: 6,
      minute: 0,
    })
  })

  it('reads a single weekday', () => {
    expect(triggerFromAnswers({ cadence: 'weekly', weekday: '3', time: '18:45' })).toEqual({
      kind: 'weekly',
      days: [3],
      hour: 18,
      minute: 45,
    })
  })

  it('reads an interval', () => {
    expect(triggerFromAnswers({ cadence: 'interval', everyMinutes: 90 })).toEqual({
      kind: 'interval',
      everyMinutes: 90,
    })
  })

  /** A nonsense time falls back rather than producing NaN o'clock. */
  it('falls back to a sane default for an unreadable time', () => {
    expect(triggerFromAnswers({ cadence: 'daily', time: 'whenever' })).toEqual({
      kind: 'daily',
      hour: 7,
      minute: 30,
    })
  })
})

describe('what the approval prompt shows', () => {
  /**
   * The whole point. What is approved is the *resulting schedule*, listing every tool it would be
   * able to use — not the model's description of what it means to create.
   */
  it('lists every granted tool, and says the grant is permanent', async () => {
    const { built } = tool({
      requestForm: async () => ({ cadence: 'daily', time: '07:00', tools: ['read_file', 'execute_command'] }),
    })
    const preview = await built.preview?.(params, {} as ToolExecutionContext)

    expect(previewText(preview)).toContain('read_file')
    expect(previewText(preview)).toContain('execute_command')
    expect(previewText(preview)).toContain('Every day at 07:00')
    expect(previewText(preview)).toContain('nobody will be asked again')
  })

  it('says plainly when nothing was granted', async () => {
    const { built } = tool({ requestForm: async () => ({ cadence: 'daily', time: '07:00', tools: [] }) })
    const preview = await built.preview?.(params, {} as ToolExecutionContext)

    expect(previewText(preview)).toContain('none')
  })

  it('shows the prompt that will actually be sent', async () => {
    const { built } = tool({ requestForm: async () => ({ cadence: 'daily', tools: [] }) })
    const preview = await built.preview?.(params, {} as ToolExecutionContext)

    expect(previewText(preview)).toContain('Report any alerts overnight.')
  })
})

describe('what happens without a completed form', () => {
  /**
   * Refused rather than guessed at. Inventing a cadence and an empty tool list would create a
   * job the user never described — and one that then runs every day.
   */
  it('creates nothing when the form was dismissed', async () => {
    const { built, created } = tool({ requestForm: async () => undefined })
    await built.preview?.(params, {} as ToolExecutionContext)
    const result = await built.execute(params, {} as ToolExecutionContext)

    expect(result.isError).toBe(true)
    expect(created).toEqual([])
  })

  /** An unattended run has nobody to fill a form in, exactly like `ask_user_form`. */
  it('is unavailable where nobody can answer', async () => {
    const built = createScheduleFromChatTool({
      schedulableTools: () => tools,
      create: async () => ({ id: 'x' }),
    })
    const result = await built.execute(params, {} as ToolExecutionContext)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('somebody present')
  })
})

describe('creating it', () => {
  it('writes exactly what was previewed', async () => {
    const { built, created } = tool({
      requestForm: async () => ({ cadence: 'weekdays', time: '06:15', tools: ['read_file'] }),
    })
    await built.preview?.(params, {} as ToolExecutionContext)
    const result = await built.execute(params, {} as ToolExecutionContext)

    expect(created).toEqual([
      {
        name: 'Morning check',
        prompt: 'Report any alerts overnight.',
        trigger: { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 6, minute: 15 },
        allowedTools: ['read_file'],
      },
    ])
    expect(result.isError).toBeUndefined()
  })

  /** Two creations from one form would be a second job nobody asked for. */
  it('does not create a second job if execute runs again', async () => {
    const { built, created } = tool({ requestForm: async () => ({ cadence: 'daily', tools: [] }) })
    await built.preview?.(params, {} as ToolExecutionContext)
    await built.execute(params, {} as ToolExecutionContext)
    const second = await built.execute(params, {} as ToolExecutionContext)

    expect(created).toHaveLength(1)
    expect(second.isError).toBe(true)
  })
})
