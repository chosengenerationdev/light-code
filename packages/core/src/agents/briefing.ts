import type { Skill } from '../skills/index.js'
import type { Tool } from '../tools/types.js'
import { AGENT_ROLES, type AgentRole } from './roles.js'
import type { ResolvedAgent } from './team.js'

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
  /**
   * The team as configured, so a specialist plans around who actually exists.
   *
   * Roles nobody assigned are absent from this list — that is `resolveTeam`'s contract — and a
   * role that *is* assigned can still be unavailable, with `reason` saying why.
   */
  team?: readonly ResolvedAgent[] | undefined
  /** Which role is being consulted, so the roster describes the others rather than itself. */
  self?: AgentRole | undefined
}

/**
 * Who else the assistant can consult, and — the part that matters — who it cannot.
 *
 * ## The reported failure
 *
 * A plan came back naming specialists that were never set up. The expert is the role most often
 * asked for a plan, and it had no idea who was on the team, so it wrote the team it would have
 * liked: "have the tester write cases for this, then the reviewer checks it." The assistant then
 * either spends a round trip being refused by `ask_agent`, or quietly skips that step — and
 * either way the user approved a plan containing work that was never going to happen.
 *
 * ## Why the absent roles are listed rather than simply omitted
 *
 * Listing only who is available reads as a *suggestion*, and a model with a strong prior about
 * how software gets reviewed will reach for a reviewer anyway. Naming the roles that are not set
 * up, and saying plainly that proposing work for them is wrong, is the difference between an
 * incomplete list and an instruction. It is a handful of tokens.
 *
 * ## Why this is not the assistant's roster
 *
 * `buildTeamGuidance` tells the *assistant* who it can consult. This tells a *specialist* the
 * same fact, because the specialist is the one writing plans that name other specialists, and it
 * cannot see the assistant's prompt. Both derive from the same `resolveTeam` result, so they
 * cannot disagree about who exists.
 */
function buildRoster(team: readonly ResolvedAgent[], self: AgentRole | undefined): string[] {
  const others = team.filter((agent) => agent.role !== self)
  const usable = others.filter((agent) => agent.available)

  const assigned = new Set(team.map((agent) => agent.role))
  const missing: string[] = []
  for (const role of AGENT_ROLES) {
    if (role === self) continue
    if (!assigned.has(role)) {
      missing.push(`- **${role}** — nobody is assigned to this role.`)
      continue
    }
    const agent = others.find((candidate) => candidate.role === role)
    if (agent !== undefined && !agent.available) {
      missing.push(`- **${role}** — ${agent.reason ?? 'assigned, but cannot be reached.'}`)
    }
  }

  const sections = ['## The rest of the team', '']

  if (self !== undefined) sections.push(`You are the **${self}**.`, '')

  sections.push(
    usable.length > 0
      ? 'The assistant can also consult these specialists, and only these:'
      : 'The assistant has **no other specialists available**. Whatever you propose, it does alone.',
  )

  if (usable.length > 0) {
    sections.push('', ...usable.map((agent) => `- **${agent.role}** (${agent.label}) — ${agent.summary}`))
  }

  if (missing.length > 0) {
    sections.push(
      '',
      // "Not set up" would be wrong for a role that *is* assigned and whose profile has since
      // gone: the user did set it up, and telling them otherwise sends them to fix the wrong
      // thing. "Not available" is true of both, and the reason beside each says which it is.
      '**Not available, so the assistant cannot use them:**',
      '',
      ...missing,
      '',
      'Do not give any of these work. Do not put them in a plan, a checklist or a next step — a',
      'plan naming a specialist who does not exist is a plan with a hole in it, and the user will',
      'have approved it without knowing. If a task genuinely needs one, say so in a sentence and',
      'say the user would have to assign it in Settings → Agents; then give the best advice you',
      'can for doing it without that role.',
    )
  }

  return sections
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
  const team = input.team
  /*
   * The roster is worth sending even in a workspace with no tools and no skills, because who else
   * exists is a fact about the *team*, not about the workspace — and it is exactly the fact a
   * plan gets wrong. So the early return now asks whether there is anything at all to say.
   */
  if (tools.length === 0 && skills.length === 0 && team === undefined) return ''

  const sections: string[] = []

  if (team !== undefined) sections.push(...buildRoster(team, input.self))

  if (tools.length > 0 || skills.length > 0) {
    if (sections.length > 0) sections.push('')
    sections.push(
      '## What the assistant can do on your behalf',
      '',
      'You have no tools. The assistant asking you does, and will carry out whatever you recommend.',
      'Name the tool or skill you mean rather than describing a manual procedure that duplicates it.',
    )
  }

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
