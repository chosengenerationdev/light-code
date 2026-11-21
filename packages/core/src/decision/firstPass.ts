import type { ObservedEvent } from '../observers/events.js'

/**
 * The decision model as the Anti Hallucinator's first pass - asked for: "does it work with anti halucinator too?".
 *
 * The Anti Hallucinator reviews every step with a full model, which is slow and costs a call per step. A decision model
 * answers one narrow question cheaply: is this step grounded in what the tools returned, and still on the user's
 * request? Sure of yes, the step is still given to the Anti Hallucinator - it keeps its whole context - but marked
 * `quiet`, so it is reviewed together with the next step that needs one rather than on its own. Unsure, or no, or no
 * answer: reviewed as always. So the first pass can only save reviews; it never removes the Anti Hallucinator.
 */

export const DEFAULT_FIRST_PASS_THRESHOLD = 0.85

export const FIRST_PASS_QUESTION =
  "Is the assistant's latest step grounded in the tool results shown (no claim they do not support), and still working on the user's request?"

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text)

/** The step as the decision model reads it: the request, then each thing done, newest last. */
export function describeStep(step: readonly ObservedEvent[], goal: string): string {
  const lines: string[] = [`User's request: ${clip(goal, 2000)}`, '', 'Latest step:']
  for (const event of step) {
    switch (event.kind) {
      case 'reasoning':
        lines.push(`Thinking: ${clip(event.text, 2000)}`)
        break
      case 'assistant':
        lines.push(`Assistant said: ${clip(event.text, 3000)}`)
        break
      case 'toolCall':
        lines.push(`Called ${event.tool}: ${clip(event.args, 1000)}`)
        break
      case 'toolResult':
        lines.push(`${event.tool} returned${event.ok ? '' : ' an error'}: ${clip(event.text, 3000)}`)
        break
      case 'refused':
        lines.push(`${event.tool} was refused: ${clip(event.reason, 500)}`)
        break
      case 'approval':
        lines.push(`The user ${event.decision} ${event.tool}.`)
        break
      case 'turnEnd':
        lines.push(`The reply ended (${event.ending}).`)
        break
      default:
        break
    }
  }
  return lines.join('\n')
}
