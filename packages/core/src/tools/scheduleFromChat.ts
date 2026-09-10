import { z } from 'zod'

import { describeTrigger } from '../schedule/timing.js'
import type { ScheduleTrigger } from '../schedule/types.js'
import type { FormField } from './askUserForm.js'
import type { Tool, ToolPreview, ToolResult } from './types.js'

/**
 * Creating a scheduled job without leaving the conversation.
 *
 * User-requested: *"scheduling a prompt can be done from normal chat window as well, where user
 * can give a prompt to schedule this as a prompt, then agent can show a list of available tools
 * which user can select the ones that are allowed for that prompt, get schedule time and
 * frequency with a form as well"*.
 *
 * ## The form collects; it does not authorise
 *
 * §6b is explicit that a submitted form is *input*, never permission — and this is the case
 * where that distinction earns its keep, because what the form collects **is a list of granted
 * capabilities**. Reading the ticked boxes as consent would put model-authored text where
 * ground truth belongs (invariant 8) and let a prompt-injected turn grant itself `execute_command`
 * at 3am by describing a form persuasively.
 *
 * So the flow is deliberately two steps. The form gathers a proposal; the ordinary approval gate
 * then shows the *resulting schedule* — its prompt, its cadence, and every tool it would be able
 * to use — and the user approves that. The preview is computed from what will actually be
 * written, not from the model's description of it.
 *
 * ## Why the tool list is passed in rather than read here
 *
 * A tool has no business enumerating the registry: what a schedule may be granted is a policy
 * question the host answers (`NEVER_AVAILABLE_TO_SCHEDULES`), and duplicating that here would be
 * a second list to keep in step with the first.
 */

const paramsSchema = z.object({
  name: z.string().min(1).describe('A short name for the job, e.g. "Morning alert check".'),
  prompt: z
    .string()
    .min(1)
    .describe('Exactly what to send when it runs, as if typed into the chat. Be specific: nobody is there to clarify.'),
})
export type ScheduleFromChatParams = z.infer<typeof paramsSchema>

export interface SchedulableTool {
  name: string
  description: string
}

export interface ScheduleProposal {
  name: string
  prompt: string
  trigger: ScheduleTrigger
  allowedTools: string[]
}

export interface ScheduleFromChatOptions {
  /** Tools this host would let a schedule use. Already filtered by the host's own policy. */
  schedulableTools: () => SchedulableTool[]
  /** Shows the form and waits. Absent for an unattended run, which cannot answer one. */
  requestForm?: (fields: FormField[], title: string) => Promise<Record<string, unknown> | undefined>
  /** Writes it. Called only after the approval gate has shown the proposal and been approved. */
  create: (proposal: ScheduleProposal) => Promise<{ id: string; nextRunAt?: number }>
}

/** Builds the form. Separate so the field shapes can be asserted without a host. */
export function scheduleFormFields(tools: readonly SchedulableTool[]): FormField[] {
  return [
    {
      name: 'cadence',
      label: 'How often should it run?',
      type: 'choice',
      required: true,
      options: [
        { value: 'daily', label: 'Every day, at a time' },
        { value: 'weekdays', label: 'Weekdays only, at a time' },
        { value: 'weekly', label: 'Once a week, at a time' },
        { value: 'interval', label: 'Every N minutes' },
      ],
    },
    {
      name: 'time',
      label: 'At what time? (24-hour, e.g. 07:30)',
      type: 'string',
      required: false,
      description: 'Local time. Ignored for "every N minutes".',
      defaultValue: '07:30',
    },
    {
      name: 'weekday',
      label: 'Which day? (for "once a week")',
      type: 'choice',
      required: false,
      options: [
        { value: '1', label: 'Monday' },
        { value: '2', label: 'Tuesday' },
        { value: '3', label: 'Wednesday' },
        { value: '4', label: 'Thursday' },
        { value: '5', label: 'Friday' },
        { value: '6', label: 'Saturday' },
        { value: '0', label: 'Sunday' },
      ],
    },
    {
      name: 'everyMinutes',
      label: 'Every how many minutes? (for "every N minutes")',
      type: 'number',
      required: false,
      defaultValue: 60,
    },
    {
      name: 'tools',
      label: 'Which tools may this job use?',
      type: 'multichoice',
      required: false,
      /*
       * The default is none, and the description says so rather than leaving it to be noticed.
       * An unattended run has nobody to approve anything, so the ticked list *is* the approval —
       * made in advance, for one named job.
       */
      description:
        'Nobody is present to approve anything when this runs, so it can use only what you tick ' +
        'here. Leaving them all unticked is a real choice: the job can still read its prompt and ' +
        'answer, it just cannot touch anything.',
      options: tools.map((tool) => ({ value: tool.name, label: tool.name })),
    },
  ]
}

function parseTime(raw: unknown): { hour: number; minute: number } {
  const text = String(raw ?? '').trim()
  const match = /^(\d{1,2})\s*[:.]\s*(\d{2})$/.exec(text)
  if (match === null) return { hour: 7, minute: 30 }
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return { hour, minute }
}

/**
 * Turns the answers into a trigger.
 *
 * Exported so the mapping is testable without a form: `weekdays` becoming five explicit days is
 * the sort of thing that is obviously right and quietly wrong.
 */
export function triggerFromAnswers(answers: Record<string, unknown>): ScheduleTrigger {
  const cadence = String(answers.cadence ?? 'daily')
  if (cadence === 'interval') {
    const minutes = Number(answers.everyMinutes)
    return { kind: 'interval', everyMinutes: Number.isFinite(minutes) && minutes >= 1 ? Math.floor(minutes) : 60 }
  }

  const { hour, minute } = parseTime(answers.time)
  if (cadence === 'weekdays') return { kind: 'weekly', days: [1, 2, 3, 4, 5], hour, minute }
  if (cadence === 'weekly') {
    const day = Number(answers.weekday)
    return { kind: 'weekly', days: [Number.isFinite(day) ? day : 1], hour, minute }
  }
  return { kind: 'daily', hour, minute }
}

export function createScheduleFromChatTool(
  options: ScheduleFromChatOptions,
): Tool<ScheduleFromChatParams> {
  /** Filled in by the form during `preview`, so the approval shows what will really be written. */
  let pending: ScheduleProposal | undefined

  return {
    name: 'schedule_prompt',
    group: 'edit',
    description:
      'Set up a prompt to run on a schedule. Asks the user for the cadence and which tools the ' +
      'job may use, then shows them the whole thing to approve. Use it when the user asks for ' +
      'something to happen regularly or overnight. Write the prompt to stand alone — nobody is ' +
      'there to clarify it when it runs.',
    parametersSchema: paramsSchema,

    /**
     * The form is shown here, during preview, so the approval that follows can describe the
     * real schedule. Collecting after approval would mean approving a blank cheque; collecting
     * without approval would mean the form was the permission, which §6b forbids.
     */
    async preview(params): Promise<ToolPreview> {
      pending = undefined
      if (options.requestForm === undefined) {
        return {
          kind: 'text',
          text: 'Scheduling from the chat needs somebody present to choose the cadence and tools. It is not available here.',
        }
      }

      const tools = options.schedulableTools()
      const answers = await options.requestForm(scheduleFormFields(tools), `Schedule "${params.name}"`)
      if (answers === undefined) {
        return { kind: 'text', text: 'The scheduling form was dismissed, so nothing will be created.' }
      }

      const chosen = Array.isArray(answers.tools) ? answers.tools.map((entry) => String(entry)) : []
      const trigger = triggerFromAnswers(answers)
      pending = { name: params.name, prompt: params.prompt, trigger, allowedTools: chosen }

      return {
        kind: 'text',
        text: [
          `Create the scheduled job "${params.name}".`,
          '',
          `Runs: ${describeTrigger(trigger)}`,
          '',
          'It will send this prompt, with nobody watching:',
          `  ${params.prompt}`,
          '',
          chosen.length === 0
            ? 'Tools it may use: none. It can answer, and nothing else.'
            : `Tools it may use, every time it runs:\n${chosen.map((name) => `  - ${name}`).join('\n')}`,
          '',
          'These tools are granted in advance — nobody will be asked again when it runs.',
        ].join('\n'),
      }
    },

    async execute(params): Promise<ToolResult> {
      if (options.requestForm === undefined) {
        return {
          content: 'Scheduling from the chat needs somebody present to answer the form.',
          isError: true,
        }
      }
      if (pending === undefined) {
        /*
         * The form was dismissed, or execute somehow ran without a preview. Refused rather than
         * guessed at: inventing a cadence and an empty tool list would create a job the user
         * never described.
         */
        return {
          content: 'No schedule was set up — the form was not completed. Ask again if it is still wanted.',
          isError: true,
        }
      }

      try {
        const created = await options.create(pending)
        const when = pending.trigger
        const summary = describeTrigger(when)
        pending = undefined
        return {
          content:
            `Scheduled "${params.name}" to run ${summary}.` +
            `${created.nextRunAt === undefined ? '' : ` Next run ${new Date(created.nextRunAt).toLocaleString()}.`}\n` +
            'It is in Settings → Schedules, where it can be paused, edited or removed.',
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}
