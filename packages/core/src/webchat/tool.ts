import { z } from 'zod'

import type { Tool, ToolExecutionContext, ToolPreview, ToolResult } from '../tools/types.js'

/**
 * `ask_web_chat`: consult the model behind the office's web chat (Gemini, at the time it was asked for) through the
 * user's own Chrome - see `setup.ts` for how, and `guard.ts` for the rules that keep it inside the organisation. Offered only
 * while a Chrome DevTools MCP server is connected (asked for: "should be available only when chrome mcp is setup").
 *
 * The approval shows the literal text and the approved backend address it goes to (invariant 8); nothing else is sent.
 */

const schema = z.object({
  question: z
    .string()
    .min(1)
    .max(60_000)
    .describe(
      'The whole question, with the code, error or output it is about pasted in: the model behind the web chat cannot see this workspace, the chat or any file. The user approves this exact text before it is sent.',
    ),
})

export type AskWebChatParams = z.infer<typeof schema>

export interface AskWebChatDeps {
  /** Where it goes, once set up: the approved backend address, and the model it names. Undefined: not set up. */
  destination(): Promise<{ backend: string; method?: 'replay' | 'window'; model?: string | undefined } | undefined>
  /** Every rule in `guard.ts`, checked now; the sentence saying what is wrong, or undefined. */
  problem(): Promise<string | undefined>
  ask(question: string, signal?: AbortSignal): Promise<string>
}

export function createAskWebChatTool(deps: AskWebChatDeps): Tool<AskWebChatParams> {
  return {
    name: 'ask_web_chat',
    group: 'mcp',
    description:
      "Consult the model behind the organisation's internal web chat (set up in Settings → Agents → Web chat) for a second opinion or a hard problem. It sees only the question - put the relevant code, error and context in it, and leave out anything the user would not paste into that chat. Every consultation is approved by the user, showing the exact text. Use it when the user asks for the web chat or Gemini, or when a second model's view is worth an approval.",
    parametersSchema: schema,
    async preview(params): Promise<ToolPreview> {
      const destination = await deps.destination()
      const where = destination === undefined ? 'the web chat (not set up yet)' : `${destination.backend}${destination.model !== undefined ? ` (model ${destination.model})` : ''}`
      return {
        kind: 'text',
        text:
          destination?.method === 'window'
            ? `Typed into the web chat window in your Chrome and sent, as you would; the answer is read from its reply from the approved backend address only:\n${where}\n\nThe exact text typed:\n\n${params.question}`
            : `Sent through your Chrome, signed in as you, to the web chat's approved backend address only:\n${where}\n\nThe exact text sent:\n\n${params.question}`,
      }
    },
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const destination = await deps.destination()
      if (destination === undefined) return { content: 'The web chat is not set up: Settings → Agents → Web chat (capture it once there).', isError: true }
      const problem = await deps.problem()
      if (problem !== undefined) return { content: `Nothing was sent. ${problem}`, isError: true }
      try {
        const answer = await deps.ask(params.question, context.signal)
        return { content: `The web chat (${destination.model ?? 'its model'}) answered:\n\n${answer}` }
      } catch (error) {
        return { content: `Nothing came back from the web chat: ${error instanceof Error ? error.message : String(error)}`, isError: true }
      }
    },
  }
}
