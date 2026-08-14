import { z } from 'zod'
import { FORGET_DOCS_TOOL } from '../context/evict.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Releases documentation the model has finished with.
 *
 * ## It deliberately does nothing
 *
 * `execute` returns a confirmation and touches no state. The actual eviction happens in
 * `context/evict.ts`, which reads this call back out of the transcript when the next request
 * is assembled — the same shape as `dropSupersededReads`.
 *
 * That indirection is the design, not an accident. A tool that mutated a shared set would
 * work until a task was resumed from disk, at which point the set would be empty and every
 * schema the model had already released would come back. Deriving from the transcript cannot
 * drift, because the transcript *is* the state.
 *
 * ## Why the model would bother
 *
 * A `search_docs` result is the most verbose thing in the conversation — a full JSON Schema —
 * and the shortest-lived: once the call is made, the parameters are of no further use. Without
 * a way to say so, every later request in the task carries them.
 */
const paramsSchema = z.object({})
export type ForgetDocsParams = z.infer<typeof paramsSchema>

export function createForgetDocsTool(): Tool<ForgetDocsParams> {
  return {
    name: FORGET_DOCS_TOOL,
    // A control tool: it performs no work on the workspace, so there is nothing to approve.
    group: 'always',
    description:
      'Release the tool documentation you have already used, freeing the context it occupies. ' +
      'Call this once you have finished with the schemas search_docs gave you — typically right ' +
      'after the call_tool invocations they were for. Anything you look up afterwards is kept, ' +
      'and you can always search again if you need something back.',
    parametersSchema: paramsSchema,

    async execute(): Promise<ToolResult> {
      /*
       * Says what the model will observe next turn rather than claiming an immediate effect:
       * the messages are rewritten when the following request is assembled, so within this
       * turn nothing has visibly changed. A model told "done" that then still sees the
       * schemas would reasonably call this again.
       */
      return {
        content:
          'Released. The documentation you looked up before this point is dropped from the ' +
          'conversation as of your next message; search_docs will find it again if needed.',
      }
    },
  }
}
