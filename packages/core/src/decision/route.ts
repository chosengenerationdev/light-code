import type { ResolvedAgent } from '../agents/team.js'
import type { ChatMessage } from '../providers/types.js'
import type { Decision, DecisionQuestion } from './decide.js'

/**
 * Agent team mode with a decision model: each message is offered to the decision model as a Choice between the main
 * assistant and every specialist that can answer, and a confident pick sends it to that specialist.
 *
 * "Sends it" reuses what `#role` already does (agents/direct.ts): the main assistant is told to consult that specialist
 * with `ask_agent` before answering. So everything a consultation is held to - approvals, read-only roles, a
 * specialist's own context and process - is unchanged; the decision model only chooses who, never grants anything.
 */

/** The option meaning "the main assistant answers it itself". Not a valid role id, so it cannot collide with one. */
export const MAIN_OPTION = '@main'

export function routeQuestion(text: string, team: readonly ResolvedAgent[], recent: readonly ChatMessage[]): DecisionQuestion {
  const context = recent
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .slice(-2)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${String(message.content).slice(0, 500)}`)
  return {
    kind: 'choice',
    question: 'Who should handle the latest request from the user?',
    options: [
      { id: MAIN_OPTION, label: 'The main assistant', description: 'questions, small changes, and anything no specialist below is better at' },
      ...team.filter((agent) => agent.available).map((agent) => ({ id: agent.role, label: agent.name, description: agent.summary })),
    ],
    inputs: {
      text: `${context.length > 0 ? `Earlier in the chat:\n${context.join('\n')}\n\n` : ''}Latest request:\n${text.slice(0, 6000)}`,
    },
  }
}

/** The specialist picked at or above the threshold, or undefined: the main assistant, or not sure enough. */
export function routedRole(decision: Decision, threshold: number): { role: string; probability: number } | undefined {
  const best = decision.best
  if (!decision.ok || best === undefined || best.id === MAIN_OPTION || best.probability < threshold) return undefined
  return { role: best.id, probability: best.probability }
}

/** What the main assistant is told, appended to the message - the `#role` wording, saying who decided. */
export function describeRoute(role: string, name: string, probability: number): string {
  return (
    `The decision model sent this request to \`${role}\` (${name}, probability ${probability.toFixed(2)}). Consult it with ` +
    '`ask_agent` before you answer: put the code, error or output the request is about in the question, and say ' +
    'plainly in your reply what came back and whether you agree. If the user then says to answer it yourself, do so.'
  )
}
