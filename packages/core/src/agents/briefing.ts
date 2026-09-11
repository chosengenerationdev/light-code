import type { Skill } from '../skills/index.js'
import type { Tool } from '../tools/types.js'

/**
 * What a specialist is told exists, so its advice is about *this* workspace.
 *
 * ## Why a specialist needs this and did not have it
 *
 * A consultation is one request with no tools. The specialist cannot read a file, search the
 * documentation index, or open a skill — so left uninformed it advises as though the assistant
 * were a bare shell: proposing that something be done by hand when a configured tool already does
 * it, or inventing a procedure that an existing skill documents.
 *
 * The Claude CLI expert has had an inventory since §12b, for exactly this reason. Provider-backed
 * roles had none at all, which made the reviewer and the librarian markedly worse than the expert
 * at the same question.
 *
 * ## Names, never schemas
 *
 * Forty MCP tools are a few hundred tokens as a list and several thousand as JSON schemas, and a
 * specialist does not need a schema to *recommend* a tool — it needs to know the tool exists. When
 * exact parameters matter it says so and the assistant looks them up. That is the same
 * name-first, body-on-demand split §13 already makes for skills.
 *
 * ## Why it is paid on every consultation
 *
 * A provider role is stateless: there is no session to remember it. The alternative is a
 * specialist that gives worse advice than it could, which costs a round trip and a wrong answer —
 * more than a few hundred tokens.
 */
const DESCRIPTION_LIMIT = 110

function firstLine(text: string, limit = DESCRIPTION_LIMIT): string {
  const line =
    text
      .split('\n')
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? ''
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line
}

export interface AgentBriefingInput {
  /** Everything the assistant can call, advertised or reachable through the dispatcher. */
  tools?: readonly Tool[] | undefined
  /** Skills available in this workspace — names and descriptions, never bodies. */
  skills?: readonly Skill[] | undefined
}

/**
 * The inventory, or an empty string when there is nothing worth saying.
 *
 * Empty rather than a section announcing that nothing exists: a heading followed by "none" is
 * noise in every consultation on a workspace with no MCP servers and no skills, which is most of
 * them.
 */
export function buildAgentBriefing(input: AgentBriefingInput): string {
  const tools = (input.tools ?? []).filter(
    // Telling a specialist it can consult a specialist is noise at best and a loop at worst.
    (tool) => tool.name !== 'ask_agent' && tool.name !== 'ask_expert',
  )
  const skills = input.skills ?? []
  if (tools.length === 0 && skills.length === 0) return ''

  const sections: string[] = [
    '## What the assistant can do on your behalf',
    '',
    'You have no tools. The assistant asking you does, and will carry out whatever you recommend.',
    'Name the tool or skill you mean rather than describing a manual procedure that duplicates it.',
  ]

  if (tools.length > 0) {
    sections.push(
      '',
      '### Tools it can call',
      '',
      ...tools.map((tool) => `- \`${tool.name}\` — ${firstLine(tool.description)}`),
    )
  }

  if (skills.length > 0) {
    sections.push(
      '',
      '### Skills written for this workspace',
      '',
      'House conventions and internal knowledge, already documented. Point at one by name rather',
      'than restating it; the assistant can open it.',
      '',
      ...skills.map((skill) => `- **${skill.name}** — ${firstLine(skill.description)}`),
    )
  }

  return sections.join('\n')
}
