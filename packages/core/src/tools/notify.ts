import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe(
      'One short sentence, on one line. A notification is plain text — line breaks, Markdown and ' +
        'formatting are not rendered, so anything longer belongs in `details`.',
    ),
  level: z
    .enum(['info', 'warning'])
    .optional()
    .describe(
      'Use warning only when something needs a person. A warning stays on screen until it is ' +
        'dismissed; an info notification fades after a few seconds.',
    ),
  details: z
    .string()
    .optional()
    .describe(
      'Optional Markdown — tables, lists, headings, code. Opened in an editor tab when the user ' +
        'clicks the notification. Put the report here and keep `message` to one line: a ' +
        'notification itself is plain text and cannot show formatting.',
    ),
})
export type NotifyParams = z.infer<typeof paramsSchema>

export interface NotifyOptions {
  /**
   * Raises the notification. The host owns how — a toast in VS Code, stderr elsewhere.
   *
   * `details` is Markdown for the host to show somewhere a document can be read. The
   * notification itself cannot render it: a VS Code toast is a plain string with buttons, so a
   * table or a coloured cell has to live in a document the toast offers to open.
   */
  notify: (message: string, level: 'info' | 'warning', details?: string) => void
}

/**
 * Surfaces something to the user when they are not looking at the panel.
 *
 * Exists for scheduled runs (§6, Phase 9b): a job that finds a problem at 3am is useless if
 * the only record is a transcript nobody opens. This is the one way an unattended run can
 * reach a person.
 *
 * **Available to interactive sessions too**, but rarely useful there — the user is already
 * reading the reply. The description says so, because a model that toasts every answer is
 * worse than one that never does.
 *
 * In the `always` group: it performs nothing on the workspace, so there is nothing to approve.
 * It is also on every schedule's implicit allowlist, since a run that could not report would
 * defeat the point of running it.
 */
export function createNotifyTool(options: NotifyOptions): Tool<NotifyParams> {
  return {
    name: 'notify',
    group: 'always',
    /*
     * The "unless asked" clause is load-bearing, and is the same lesson 0.3.1 recorded about
     * the expert: frugality guidance written for the model's own initiative gets applied to
     * direct instructions too, and the user is left arguing with an assistant that refuses to
     * do a simple thing it plainly can. "Send me a test notification" must just work.
     */
    description:
      'Raise a notification the user will see even when the Light Code panel is closed. ' +
      'The notification is one line of plain text; put any report, table or listing in `details` ' +
      'as Markdown and it becomes a document they can open from it. ' +
      'If the user asks you to notify them, or to test notifications, do it — that is a direct ' +
      'instruction. On your own initiative use it only from a scheduled run reporting something ' +
      'that needs attention; in an ordinary conversation they are already reading your reply.',
    parametersSchema: paramsSchema,

    async execute(params): Promise<ToolResult> {
      /*
       * Flattened, not rejected.
       *
       * A notification is a single line whatever is passed to it, so a multi-line `message`
       * would be silently mangled by the platform. Collapsing it here at least keeps it
       * readable, and `details` is where the model is told to put the real content.
       */
      const line = params.message.replace(/\s+/g, ' ').trim()
      options.notify(line, params.level ?? 'info', params.details)
      return {
        content:
          params.details === undefined
            ? `Notified the user: ${params.message}`
            : `Notified the user: ${params.message} (with a report they can open)`,
      }
    },
  }
}
