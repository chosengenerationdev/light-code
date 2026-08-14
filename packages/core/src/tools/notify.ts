import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  message: z.string().min(1).describe('One short sentence. It is read out of context, in a notification.'),
  level: z.enum(['info', 'warning']).optional().describe('Use warning only when something needs a person.'),
})
export type NotifyParams = z.infer<typeof paramsSchema>

export interface NotifyOptions {
  /** Raises the notification. The host owns how — a toast in VS Code, stderr elsewhere. */
  notify: (message: string, level: 'info' | 'warning') => void
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
      'If the user asks you to notify them, or to test notifications, do it — that is a direct ' +
      'instruction. On your own initiative use it only from a scheduled run reporting something ' +
      'that needs attention; in an ordinary conversation they are already reading your reply.',
    parametersSchema: paramsSchema,

    async execute(params): Promise<ToolResult> {
      options.notify(params.message, params.level ?? 'info')
      return { content: `Notified the user: ${params.message}` }
    },
  }
}
