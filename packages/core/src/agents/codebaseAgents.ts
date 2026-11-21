import { z } from 'zod'
import type { ChatMessage } from '../providers/types.js'
import type { Tool, ToolResult } from '../tools/types.js'

/**
 * One codebase's agent asking another's, in Fire Code.
 *
 * Asked for: "agent from one code base can talk to another agent that's in another code base to get help or do
 * certain things". The request goes through Fire Code - the private pipe each chat already has to it, never a
 * socket - which opens **a new chat tab on the other codebase** and starts it on the request. That agent works with
 * its own files, tools, skills and instructions, and **asks for its own approvals in its own tab**, where the user
 * can watch it or step in. When its turn ends, its answer comes back as this tool's result.
 *
 * Why a visible tab rather than a hidden consultation: the other agent may change its codebase. A change nobody
 * can see being made, approved in a window that is not the one it happens in, is the thing invariant 8 rules out.
 *
 * Chains are bounded (`MAX_DEPTH`): an agent working for another may ask a third, but not without end.
 */

export interface CodebaseAgentTask {
  id: string
  /** The asking codebase's name. */
  from: string
  message: string
  /** How many asks deep this is: 1 for a request a user's own agent made. */
  depth: number
}

export interface CodebaseAgentReply {
  ok: boolean
  text: string
  /** The tab it worked in, so the asking agent can tell the user where to look. */
  chat?: string
}

/** What Fire Code provides; absent elsewhere, and then the tool is too. */
export interface CodebaseAgentChannel {
  ask(codebase: string, message: string, options: { timeoutMs: number; depth: number; signal?: AbortSignal }): Promise<CodebaseAgentReply>
  /** Requests from other codebases' agents, for this chat to work on. */
  onTask(handler: (task: CodebaseAgentTask) => void): void
  /** This chat's answer to a task. `waiting`: it stopped to ask the user, so its tab is kept open. */
  done(id: string, reply: { ok: boolean; text: string; waiting?: boolean }): void
}

export const MAX_DEPTH = 3
const DEFAULT_MINUTES = 30

const schema = z.object({
  codebase: z.string().min(1).describe('The other codebase, by its name as listed in this tool\'s description.'),
  request: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      'What you need, written for an agent that knows nothing of this conversation: the question or the task, the ' +
        'context it needs (names, paths, versions, what you already tried) and what answer you want back.',
    ),
  timeoutMinutes: z.number().int().min(1).max(120).optional().describe(`How long to wait for the answer (default ${String(DEFAULT_MINUTES)}).`),
})

export function createAskCodebaseAgentTool(options: {
  channel: CodebaseAgentChannel
  codebases: readonly { name: string }[]
  /** This chat's depth when it is itself working for another agent; 0 for a user's own chat. */
  depth: () => number
}): Tool<z.infer<typeof schema>> {
  const names = options.codebases.map((codebase) => `"${codebase.name}"`).join(', ')
  return {
    name: 'ask_codebase_agent',
    group: 'command',
    description:
      `Ask the agent of another codebase open in Fire Code for help, or to do something there: ${names}. It opens a new ` +
      'chat on that codebase and works on your request with its own files, tools and knowledge - its approvals are asked ' +
      'in its own tab - and its answer comes back here. Use it when the answer or the change lives in that codebase ' +
      '(how its API works, what it expects, a change to make there), not for files you can read yourself. Write the ' +
      'request so it stands alone. Waits for the answer.',
    parametersSchema: schema,
    async preview(params) {
      return {
        kind: 'text',
        text:
          `Send to the agent in codebase "${params.codebase}" - it opens a new chat there, works with that codebase's own ` +
          `tools and asks for its own approvals in that tab:\n\n${params.request}`,
      }
    },
    async execute(params, context): Promise<ToolResult> {
      const depth = options.depth() + 1
      if (depth > MAX_DEPTH) {
        return {
          content: `Not sent: this chat is already working for another agent ${String(depth - 1)} level(s) deep, and requests stop at ${String(MAX_DEPTH)}. Answer with what you have, saying what is missing.`,
          isError: true,
        }
      }
      try {
        const reply = await options.channel.ask(params.codebase, params.request, {
          timeoutMs: (params.timeoutMinutes ?? DEFAULT_MINUTES) * 60_000,
          depth,
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        })
        const where = reply.chat !== undefined ? ` (its chat "${reply.chat}")` : ''
        if (!reply.ok) return { content: `The agent in "${params.codebase}"${where} could not answer: ${reply.text}`, isError: true }
        return { content: `The agent in "${params.codebase}"${where} answered:\n\n${reply.text}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { content: `No answer from "${params.codebase}": ${message}`, isError: true }
      }
    },
  }
}

/** What the other codebase's agent is told: the request, who asked, and how its answer gets back. */
export function composeTaskMessage(task: CodebaseAgentTask): string {
  return [
    `**A request from the agent working in codebase "${task.from}".** It is waiting for your answer; the user can see this chat.`,
    '',
    task.message,
    '',
    '---',
    'Work on it here with your own tools, as you would for the user. When you are done, call attempt_completion: its result',
    'is sent back to that agent, so make it the complete answer - what you found or changed, and anything it must do on its',
    'side. If you need the user\'s decision, ask with ask_followup_question; the other agent is told you are waiting.',
  ].join('\n')
}

/** The answer to send back, from how this chat's turn ended. */
export function answerFromConversation(messages: readonly ChatMessage[]): { ok: boolean; text: string; waiting?: boolean } {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined || message.role !== 'assistant') continue
    for (const call of message.toolCalls ?? []) {
      const args = parseArgs(call.arguments)
      if (call.name === 'attempt_completion' && typeof args.result === 'string') return { ok: true, text: args.result }
      if (call.name === 'ask_followup_question' && typeof args.question === 'string') {
        return {
          ok: true,
          text: `It stopped to ask the user: ${args.question}\n\n(It is waiting for an answer in its tab; the user can reply there, and that work continues there - not here.)`,
          waiting: true,
        }
      }
    }
    if (message.content.trim().length > 0) return { ok: true, text: message.content.trim() }
  }
  return { ok: false, text: 'Its turn ended without an answer (stopped, or it failed - see its tab).' }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw.length > 0 ? raw : '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
