import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolResult } from './types.js'

/**
 * Waiting, so the assistant can look again later — a job still running, a build still queued, a
 * file not written yet. Asked for directly: "tools to wait and look for things when needed".
 *
 * **It only waits.** The obvious bigger tool — "wait until this other tool's result matches" —
 * would run that tool from inside its own `execute`, and the agent loop unwraps `call_tool` before
 * approval precisely so a tool is never run behind another one's approval (see `agent/loop.ts`).
 * So the pattern is check, wait, check: every look is an ordinary call, shown and gated like any
 * other, and a read the user auto-approves costs them nothing.
 *
 * **It ends early when somebody types or reacts.** A ten-minute wait must never make a person
 * wait ten minutes for a reply to a message they just sent; the turn picks the message up at the
 * next step, which is the moment this returns.
 *
 * It touches nothing — no file, network or process — which is why it is in the `always` group and
 * available to a scheduled run, where polling is most of the point.
 */

/** Long enough for a slow job to move on; short enough that a stuck turn is visibly a choice. */
export const MAX_WAIT_SECONDS = 900

const schema = z.object({
  seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_WAIT_SECONDS)
    .describe(`How long to wait, 1–${String(MAX_WAIT_SECONDS)} seconds. Prefer fewer, longer waits: every check and every wait is a step.`),
  reason: z.string().max(200).optional().describe('What you are waiting for, shown to the user — e.g. "PAY_EOD to finish".'),
})

export type WaitParams = z.infer<typeof schema>

export function createWaitTool(options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Tool<WaitParams> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  return {
    name: 'wait',
    group: 'always',
    description:
      'Wait before looking again — for a job, build, deployment or file that is not ready yet. Check with the ' +
      'ordinary tool, wait, then check again; say what you are waiting for in `reason`. Ends early if the user ' +
      `sends a message. Up to ${String(MAX_WAIT_SECONDS)} seconds per call; for longer, wait again after checking.`,
    parametersSchema: schema,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const started = now()
      const until = started + params.seconds * 1000
      const what = params.reason !== undefined && params.reason.trim().length > 0 ? ` for ${params.reason.trim()}` : ''
      while (now() < until) {
        if (context.signal?.aborted === true) {
          return { content: `Wait${what} cancelled after ${String(Math.round((now() - started) / 1000))}s.`, isError: true }
        }
        if (context.hasNewUserInput?.() === true) {
          return {
            content: `Stopped waiting${what} after ${String(Math.round((now() - started) / 1000))}s: the user has sent something. Read it before carrying on.`,
          }
        }
        await sleep(Math.min(1000, until - now()))
      }
      return { content: `Waited ${String(params.seconds)}s${what}. Check again now.` }
    },
  }
}
