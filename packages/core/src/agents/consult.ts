import type { ChatMessage, ChatProvider, ToolDefinition } from '../providers/types.js'
import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import type { Tool, ToolExecutionContext } from '../tools/types.js'

/**
 * A consultation that can look things up for itself.
 *
 * ## Why a specialist needed this
 *
 * It was one request with no tools: it knew only what the assistant pasted into the question. That
 * makes a reviewer guess at the code around a change, and a librarian answer about skills it has
 * never read. The Claude CLI expert has had `Read`, `Grep` and `Glob` since §12b for exactly this
 * reason, and gathering its own context is most of why its advice is better.
 *
 * ## Read-only, and that is the whole security story
 *
 * The tools offered here are the read group and nothing else — no edit, no command, no MCP, no
 * Python. A specialist cannot change the workspace, so there is nothing for an approval gate to
 * protect and nothing a prompt-injected instruction inside a file could make it *do*. §12b rejected
 * the full-agent alternative for the CLI expert on the same grounds, and this keeps that line.
 *
 * Those reads are **not** put through the approval gate, which is a deliberate difference from the
 * main loop. The CLI expert's own reads are not either — it holds Claude's tools in its own
 * process, outside this product's gate entirely. Prompting the user mid-consultation for each file
 * a reviewer wants would train them to click through prompts, which is worse than the thing it
 * would be protecting. Confinement and the path deny list still apply: they live inside the tools
 * themselves, and these are the same tool objects the assistant uses.
 *
 * ## Why it must answer when it runs out
 *
 * A specialist that spent its budget exploring and returned an error has cost a round trip and
 * given nothing. Told to answer with what it has, it returns something usable and says it was cut
 * short — which the asker can act on, or ask again with more context.
 */
export const CONSULT_MAX_STEPS = 5

/** The groups a specialist may use. Read only, and nothing that reaches outside this machine. */
const ALLOWED_GROUPS = new Set(['read'])

/**
 * Tools a specialist may call.
 *
 * Filtered by group rather than by name, so a read tool added later is available without anybody
 * remembering — and, more importantly, a tool added to a *different* group never becomes available
 * by being forgotten about here. The exclusions are the consultation tools themselves: letting a
 * specialist consult a specialist is a loop with a bill attached.
 */
export function toolsForConsultation(
  all: readonly Tool[],
  /**
   * Names allowed past the group filter, each of which **must** be approval-gated below.
   *
   * One entry today: `write_skill`, for the librarian. A name here that is not in
   * `ALWAYS_ASK_TOOLS` would put an ungated write in the one path that asks nobody, so
   * `consultBoundary.test.ts` checks that every extra is always-ask.
   */
  extra: ReadonlySet<string> = new Set<string>(),
): Tool[] {
  return all.filter(
    (tool) =>
      (ALLOWED_GROUPS.has(tool.group) || extra.has(tool.name)) &&
      tool.name !== 'ask_agent' &&
      tool.name !== 'ask_expert',
  )
}

export interface ConsultationResult {
  advice: string
  /** How many tool calls it made, for the log. */
  steps: number
  /** True when it hit the cap and was asked to answer with what it had. */
  truncated: boolean
}

export interface ConsultationOptions {
  /**
   * Asked before any tool in `ALWAYS_ASK_TOOLS`. Absent means such a tool is refused.
   *
   * Deliberately not on `ToolExecutionContext`: it belongs to *this* consultation, and putting it
   * on the shared context would hand an approver to every other caller of these tools.
   */
  approve?: (tool: Tool, args: unknown) => Promise<boolean>
  provider: ChatProvider
  prompt: string
  tools: readonly Tool[]
  definitions: readonly ToolDefinition[]
  context: ToolExecutionContext
  maxSteps?: number
  signal?: AbortSignal | undefined
  /** Reports each lookup, so a consultation is not a silent gap in the log. */
  onStep?: (name: string) => void
}

export async function runConsultation(options: ConsultationOptions): Promise<ConsultationResult> {
  const limit = options.maxSteps ?? CONSULT_MAX_STEPS
  const messages: ChatMessage[] = [{ role: 'user', content: options.prompt }]
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]))

  let steps = 0
  for (;;) {
    const atCap = steps >= limit
    let text = ''
    let call: { id: string; name: string; arguments: string } | undefined

    for await (const chunk of options.provider.streamChat(messages, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      /*
       * The tools are withdrawn on the final pass, not merely discouraged.
       *
       * A model asked politely to stop looking things up will sometimes look one more thing up,
       * and then there is no turn left to answer in. Removing them makes answering the only
       * available move.
       */
      ...(atCap || options.definitions.length === 0 ? {} : { tools: [...options.definitions] }),
    })) {
      if (chunk.type === 'text') text += chunk.text
      else if (chunk.type === 'toolCall' && call === undefined) {
        call = {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          arguments: chunk.toolCall.arguments,
        }
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error)
      }
    }

    if (call === undefined) return { advice: text, steps, truncated: atCap && steps > 0 }

    messages.push({ role: 'assistant', content: text, toolCalls: [call] })
    options.onStep?.(call.name)
    steps += 1

    const tool = byName.get(call.name)
    if (tool === undefined) {
      /*
       * Answered as a tool result rather than thrown.
       *
       * A specialist reaching for `execute_command` has simply misjudged what it has; telling it
       * so and letting it carry on is worth more than ending the consultation, and the sentence
       * names what it *can* use so the next step is not another guess.
       */
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content:
          `You have no "${call.name}". You are read-only here: ${[...byName.keys()].join(', ')}. ` +
          'Anything else, recommend and the assistant will do it.',
      })
      continue
    }

    try {
      const parsed = tool.parametersSchema.safeParse(JSON.parse(call.arguments || '{}'))

      /*
       * A tool that would normally stop and ask still stops and asks, even here.
       *
       * Consultation calls deliberately bypass the approval gate: prompting for every file a
       * reviewer opens would train the user to click through prompts, and a read is harmless
       * enough to make that trade worth it. `write_skill` is neither frequent nor harmless — a
       * skill is prose injected into every later prompt, and §13 requires a human to see the
       * source. Asking once, for something rare that matters, is not what that blanket rule was
       * arguing against.
       *
       * With no approver the call is refused rather than quietly allowed, the same direction
       * `requestPathAccess` fails in when there is nobody to answer.
       */
      /*
       * Anything that is not a read is asked about.
       *
       * The first rule here was `ALWAYS_ASK_TOOLS.has(name)`, which was right while the only
       * extra was `write_skill` — and quietly wrong the moment a role could be given
       * `write_to_file`, because an ordinary edit is *not* on that list. It would have run with
       * nobody asked, in the one path that asks nobody by default.
       *
       * The group is the honest test: the filter admits `read` and nothing else, so any other
       * group present at all arrived through `extra` and is privileged by definition. A tool
       * added to the read group later stays free, and one added anywhere else is gated without
       * anybody remembering to list it.
       */
      const permitted =
        (tool.group === 'read' && !ALWAYS_ASK_TOOLS.has(tool.name)) ||
        (options.approve !== undefined && (await options.approve(tool, parsed.data)))

      const result = !permitted
        ? {
            content:
              `The user did not approve ${tool.name}. Say what you would have written and why, ` +
              'and let the assistant put it to them instead.',
          }
        : parsed.success
        ? await tool.execute(parsed.data as never, options.context)
        : {
            content: `Those arguments are not valid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          }
      messages.push({ role: 'tool', toolCallId: call.id, content: String(result.content) })
    } catch (error) {
      // A failed lookup is information, not the end of the consultation: "that file is not there"
      // is often exactly what the specialist needed to know.
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `That failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }

    if (steps >= limit) {
      messages.push({
        role: 'user',
        content:
          'That is all the looking up you can do. Answer now with what you have, and say plainly ' +
          'what you could not check.',
      })
    }
  }
}
