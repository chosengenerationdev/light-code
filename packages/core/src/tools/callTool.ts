import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'

/**
 * Invokes a tool that was never advertised in the prompt.
 *
 * ## Why this exists
 *
 * Tool definitions sit at the front of the prompt, and a few MCP servers can contribute
 * forty tools each. §12 forbids the obvious fix — varying the definitions per turn destroys
 * the prompt-cache prefix and every message after it. This is the structural answer instead:
 * **one** stable entry point that never changes, with the schemas it can reach moved out to
 * a vector store and retrieved as tool *results*, mid-conversation, where they cost nothing
 * at the prefix.
 *
 * So the model's route to a hidden tool is `search_docs` → read the schema from the result →
 * `call_tool`. The prefix is byte-identical whether the workspace has three MCP tools or
 * three hundred.
 *
 * ## It is never executed, and that is the security design
 *
 * `execute` below is unreachable. `prepareToolCall` in the agent loop **unwraps** a
 * `call_tool` invocation into the inner tool and its arguments before anything else happens,
 * so the checkpoint, the approval gate, mode filtering and the command allowlist all see the
 * real tool — `s3__delete_object`, not `call_tool`.
 *
 * That ordering is the whole point. Had this been implemented as an ordinary tool that
 * resolved and ran its target inside `execute`, then approving `call_tool` once would have
 * approved *every* hidden tool behind it, and "always allow" would have become a blanket
 * grant over an open-ended set. Unwrapping first means there is no such thing as approving
 * `call_tool`; the user is always asked about the thing that will actually run.
 *
 * `execute` therefore returns an error rather than doing the dispatch itself. If it is ever
 * reached, the unwrap has been bypassed and the safe answer is to do nothing.
 */

export const callToolParamsSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('The exact tool name from a search_docs result, e.g. "filesystem__read_file".'),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Arguments for that tool, matching the JSON schema search_docs returned for it.'),
})
export type CallToolParams = z.infer<typeof callToolParamsSchema>

export const CALL_TOOL_NAME = 'call_tool'

export function createCallToolTool(): Tool<CallToolParams> {
  return {
    name: CALL_TOOL_NAME,
    // Control-tool group: this never performs work itself, so it is not approval-worthy.
    // The inner tool it unwraps to carries its own real group, and that is what gets gated.
    group: 'always',
    description:
      'Run a tool that is not listed above. Many tools — MCP servers, Python tools — are not ' +
      'described here to keep the prompt small; use search_docs to find one and read its schema, ' +
      'then call it through this. The user still approves whatever it runs, exactly as if it had ' +
      'been listed. If the tool you want IS listed above, call it directly instead.',
    parametersSchema: callToolParamsSchema,

    async execute(): Promise<ToolResult> {
      /*
       * Unreachable: the loop unwraps this before dispatch. Reaching it means the unwrap was
       * bypassed, and running the inner tool from here would skip the approval gate — so it
       * reports instead of dispatching.
       */
      return {
        content:
          'call_tool was not resolved to a target tool. This is a bug in Light Code; nothing was run. ' +
          'Try calling the tool directly by name.',
        isError: true,
      }
    },
  }
}
