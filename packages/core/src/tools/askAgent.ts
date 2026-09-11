import { z } from 'zod'

import { AGENT_ROLES, isAgentRole, type AgentRole } from '../agents/roles.js'
import type { ResolvedAgent } from '../agents/team.js'
import type { Tool, ToolResult } from './types.js'

const paramsSchema = z.object({
  role: z
    .string()
    .describe(
      `Which specialist to ask: ${AGENT_ROLES.join(', ')}. Only the ones assigned in Settings → Agents can answer.`,
    ),
  question: z
    .string()
    .min(1)
    .describe(
      'The question, with the code, error or output needed to answer it. The specialist cannot ' +
        'see this conversation or read files — paste what matters.',
    ),
  files: z
    .array(z.string())
    .optional()
    .describe('Workspace-relative paths you are working in, so it knows what you are looking at.'),
})
export type AskAgentParams = z.infer<typeof paramsSchema>

export interface AskAgentOptions {
  /** The team as configured, resolved fresh each turn. */
  agents: () => readonly ResolvedAgent[]
  /** Consults one specialist. Supplied by the host, which owns providers and the CLI. */
  consult: (
    agent: ResolvedAgent,
    request: { question: string; files?: string[] | undefined; signal?: AbortSignal | undefined },
  ) => Promise<{ advice: string; label: string }>
  /** Keeps the answer so it can be re-read for free — see `recall_expert_advice`. */
  onAdvice?: (record: { at: number; question: string; advice: string }) => void
}

/**
 * One tool for the whole team, with the role as an argument.
 *
 * ## Why one tool and not one per role
 *
 * §12: tool definitions sit at the front of the prompt, so a block that grows or changes with the
 * user's configuration invalidates the cache prefix *and every turn after it*. `ask_agent` is
 * byte-identical whether one role is assigned or five, and assigning a sixth changes nothing about
 * the prefix. Five separate tools would have made the team's size a property of the prompt.
 *
 * The cost is that the model must learn which roles exist, and it learns that from the mode
 * guidance — a *result*-side list, where it is free.
 *
 * ## Why an unknown role is a tool error rather than a schema error
 *
 * The role is a string, not an enum, for the same reason: an enum would list the assigned roles
 * and therefore vary with configuration. So validation happens here, where it can say *which*
 * roles are available on this machine — which is more useful than "invalid enum value" anyway.
 */
export function createAskAgentTool(options: AskAgentOptions): Tool<AskAgentParams> {
  return {
    name: 'ask_agent',
    group: 'read',
    description:
      'Consult a specialist model about the work: plan a hard change (expert), have a finished ' +
      'change reviewed (reviewer), find out what would break it (tester), write a piece of code ' +
      '(programmer), or ask how this codebase does something (librarian). ' +
      'The specialist cannot see this conversation, cannot read files and does not remember ' +
      'earlier consultations — put everything it needs in the question, including the actual code. ' +
      'What comes back is advice: check it against the real code before acting on it.',
    parametersSchema: paramsSchema,

    async preview(params) {
      const agent = find(options.agents(), params.role)
      return {
        kind: 'text' as const,
        // Ground truth (invariant 8): the question that will be sent, in full, and who to. This
        // puts the user's code in front of another model, which is the decision being approved.
        text:
          `Ask the ${params.role}${agent === undefined ? '' : ` (${agent.label})`}:\n\n${params.question}` +
          (params.files !== undefined && params.files.length > 0
            ? `\n\nFiles named as relevant: ${params.files.join(', ')}`
            : ''),
      }
    },

    async execute(params, context): Promise<ToolResult> {
      const team = options.agents()
      const role = params.role.trim().toLowerCase()

      if (!isAgentRole(role)) {
        return { content: unknownRole(role, team), isError: true }
      }

      const agent = find(team, role)
      if (agent === undefined) {
        return {
          content:
            `No ${role} is assigned. ${describeTeam(team)} ` +
            'Assign one in Settings → Agents, or ask a different role.',
          isError: true,
        }
      }
      if (!agent.available) {
        return {
          content: `The ${role} cannot be reached: ${agent.reason ?? 'it is unavailable.'}`,
          isError: true,
        }
      }

      let result
      try {
        result = await options.consult(agent, {
          question: params.question,
          ...(params.files !== undefined ? { files: params.files } : {}),
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        })
      } catch (error) {
        return {
          content: `The ${role} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        }
      }

      if (result.advice.trim().length === 0) {
        return {
          content: `The ${role} returned nothing. Check what is assigned to it in Settings → Agents.`,
          isError: true,
        }
      }

      options.onAdvice?.({ at: Date.now(), question: params.question, advice: result.advice })

      return {
        content:
          `${result.advice}\n\n---\n\n` +
          `That is the ${role}'s advice, from ${result.label}, which has not seen your workspace. ` +
          'Check it against the actual code before acting on it, and say so if it turns out to be wrong.',
      }
    },
  }
}

function find(team: readonly ResolvedAgent[], role: string): ResolvedAgent | undefined {
  const wanted = role.trim().toLowerCase()
  return team.find((agent) => agent.role === wanted)
}

/**
 * Names what *is* available, rather than only what is not.
 *
 * A model told "invalid role" tries another guess. A model told which roles exist picks one, and
 * the round trip is not wasted.
 */
function unknownRole(role: string, team: readonly ResolvedAgent[]): string {
  return `There is no "${role}" role. The roles are: ${AGENT_ROLES.join(', ')}. ${describeTeam(team)}`
}

function describeTeam(team: readonly ResolvedAgent[]): string {
  const usable = team.filter((agent) => agent.available).map((agent) => agent.role as AgentRole)
  return usable.length === 0
    ? 'None are assigned on this machine.'
    : `Assigned here: ${usable.join(', ')}.`
}
