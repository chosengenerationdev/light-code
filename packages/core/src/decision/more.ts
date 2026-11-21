import type { ChatMessage } from '../providers/types.js'
import type { Decision, DecisionQuestion } from './decide.js'
import { MAIN_OPTION } from './route.js'

/**
 * The rest of the decision model's uses, each asked for together ("please implement the pending ones too") and each
 * present only when a decision model is set up: hand-over scores, role suggestions during a turn, and whether a changed
 * plan starts new work. The questions and the readings live here so they can be tested without a host.
 */

/** A hand-over scored below this (0 to 1) is asked for once more. */
export const DEFAULT_HANDOVER_THRESHOLD = 0.4

export function handoverQuestion(contract: string, answer: string): DecisionQuestion {
  return {
    kind: 'score',
    question: `How completely does this answer give what was agreed to be handed over: "${contract.trim()}"?`,
    inputs: { text: answer.slice(0, 16_000) },
  }
}

export function newWorkQuestion(previous: string, next: string): DecisionQuestion {
  return {
    kind: 'yesno',
    question: 'Is the new plan for a different piece of work, rather than a revision of the old plan for the same work?',
    inputs: { text: `Old plan:\n${previous.slice(0, 6000)}\n\nNew plan:\n${next.slice(0, 6000)}` },
  }
}

/**
 * The advice given with a consultation when the decision model is sure another specialist fits the question better -
 * undefined when it agrees, prefers the main assistant, or is not sure.
 */
export function roleSuggestion(decision: Decision, asked: string, threshold: number, nameOf: (role: string) => string): string | undefined {
  const best = decision.best
  if (!decision.ok || best === undefined || best.id === MAIN_OPTION || best.id === asked || best.probability < threshold) return undefined
  return `[Decision model] ${nameOf(best.id)} (\`${best.id}\`) may fit this question better than ${nameOf(asked)} (probability ${best.probability.toFixed(2)}). Consult it too if the answer above falls short.`
}

/** Fire Code monitoring: does this alert need a person now? `context` is what Fire Code sends - monitor, level, rows. */
export function triageQuestion(context: Record<string, unknown>): DecisionQuestion {
  return {
    kind: 'yesno',
    question: 'Does this monitoring alert need a person to act now, rather than being looked at later?',
    inputs: { json: context },
  }
}

/**
 * What a chat asks the decision model to pick for each request: skills only, tools only, or both. Asked for: "choosing the
 * right skill is enough at some times because skill will tell right tools to use most of the times" - one question
 * instead of two, so also the quicker one.
 */
export type SkillToolPicks = 'skills' | 'tools' | 'both'

export function isSkillToolPicks(value: unknown): value is SkillToolPicks {
  return value === 'skills' || value === 'tools' || value === 'both'
}

/**
 * The request as the decision model reads it: the last two messages of the chat as well (asked for: "please close the
 * gaps" - a follow-up such as "now do the same for production" says nothing on its own).
 */
export function withRecentChat(text: string, recent: readonly ChatMessage[]): string {
  const context = recent
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .slice(-2)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${String(message.content).slice(0, 500)}`)
  return `${context.length > 0 ? `Earlier in the chat:\n${context.join('\n')}\n\n` : ''}Latest request:\n${text.slice(0, 8000)}`
}

/** The option meaning "nothing in particular" in the skill and tool questions. */
export const NOTHING_OPTION = '@nothing'

/** Suggested when at least this sure, at most this many of each. */
export const DEFAULT_SUGGEST_THRESHOLD = 0.25
const MAX_SUGGESTED = 3

const firstSentence = (text: string): string => {
  const line = text.split('\n')[0] ?? ''
  const end = line.search(/\.(\s|$)/)
  const sentence = end > 0 ? line.slice(0, end + 1) : line
  return sentence.length > 160 ? `${sentence.slice(0, 160)}…` : sentence
}

/**
 * Which skill, and which tool, a request needs - asked for: "right skill to choose and right tool to choose, can we
 * make the decision model to choose that too?". Two choice questions, each with "nothing in particular" as an option, so
 * a request that needs neither says so rather than being given the least bad.
 */
export function skillQuestion(text: string, skills: readonly { name: string; description: string }[]): DecisionQuestion {
  return {
    kind: 'choice',
    question: 'Which skill (written know-how) does this request need most?',
    options: [{ id: NOTHING_OPTION, label: 'Nothing in particular', description: 'none of these skills is about this request' }, ...skills.slice(0, 250).map((skill) => ({ id: skill.name, label: skill.name, description: firstSentence(skill.description) }))],
    inputs: { text },
  }
}

export function toolQuestion(text: string, tools: readonly { name: string; description: string }[]): DecisionQuestion {
  return {
    kind: 'choice',
    question: 'Which tool does this request need most?',
    options: [{ id: NOTHING_OPTION, label: 'Nothing in particular', description: 'no tool here is clearly the one for this' }, ...tools.slice(0, 250).map((tool) => ({ id: tool.name, label: tool.name, description: firstSentence(tool.description) }))],
    inputs: { text },
  }
}

/** The picks a decision gives: options at or above the threshold, best first, "nothing in particular" left out. */
export function picked(decision: Decision | undefined, threshold = DEFAULT_SUGGEST_THRESHOLD): { id: string; probability: number }[] {
  if (decision === undefined || !decision.ok || decision.probabilities === undefined) return []
  if (decision.best?.id === NOTHING_OPTION) return []
  return Object.entries(decision.probabilities)
    .filter(([id, p]) => id !== NOTHING_OPTION && p >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SUGGESTED)
    .map(([id, probability]) => ({ id, probability }))
}

/**
 * What the main assistant is told, appended to the request: which skill to read and which tool to use, with how to
 * reach a hidden one. Advice - it still decides, and every tool is still approved as always.
 */
export function describeSuggestions(
  skills: readonly { id: string; probability: number; filePath?: string | undefined }[],
  tools: readonly { id: string; probability: number; hidden: boolean }[],
): string {
  if (skills.length === 0 && tools.length === 0) return ''
  const parts: string[] = []
  for (const skill of skills) parts.push(`skill \`${skill.id}\` (${skill.probability.toFixed(2)})${skill.filePath !== undefined ? ` - read ${skill.filePath} first` : ''}`)
  for (const tool of tools) parts.push(`tool \`${tool.id}\` (${tool.probability.toFixed(2)})${tool.hidden ? ' - its parameters come from search_docs, then call it through call_tool' : ''}`)
  return `[Decision model] For this request these look right: ${parts.join('; ')}. Use them if they fit; this is advice, not an instruction.`
}
