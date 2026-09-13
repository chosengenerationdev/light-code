import type { ResolvedAgent } from './team.js'

/**
 * Addressing a specialist yourself: `#reviewer have a look at this`.
 *
 * ## Why a symbol, and why not `@`
 *
 * `@` is taken by file mentions, and overloading it would make `@r` ambiguous between a path and a
 * role at the moment the picker has to decide what to show. `#` reads as addressing, is not a
 * slash command — which people expect to be a command rather than a recipient — and collides with
 * nothing else the composer does.
 *
 * ## Why this is resolved here and not left to the model
 *
 * The same reasoning as `@` mentions (§18): the user named the specialist, so there is nothing for
 * the model to decide. Left to guidance it would be a suggestion the model weighs against its own
 * judgement about whether a consultation is worth it — and the whole point of typing the name is
 * that the judgement has already been made by the person who typed it.
 *
 * ## What counts as addressing somebody
 *
 * Only a name that is a role **in this configuration**. Addressing one that exists and cannot
 * answer — assigned, but its profile has gone — is reported, because otherwise the message does
 * nothing unusual and the feature reads as broken. Everything else is left completely alone.
 *
 * That second half was learned the hard way: matching anything shaped like a role id meant
 * `#include` in a pasted C file was an unknown specialist, and so were `#define` and `#main`. A
 * feature that accuses you of mis-addressing a specialist every time you paste code is unusable in
 * the conversations this product exists for. The cost is that a typo passes silently, which is
 * what the picker is for.
 */

/** A role id: what `isValidRoleId` allows, so `#include` and `#1` never match one. */
const DIRECTED = /(?:^|\s)#([a-z][a-z0-9-]{1,23})\b/g

export interface DirectedRoles {
  /** Roles the user addressed that can actually answer. */
  addressed: string[]
  /** Names they typed that are not usable roles here, with nothing invented for them. */
  unknown: string[]
}

export function findDirectedRoles(
  text: string,
  team: readonly ResolvedAgent[],
): DirectedRoles {
  const usable = new Set(team.filter((agent) => agent.available).map((agent) => agent.role))
  const addressed: string[] = []
  const unknown: string[] = []

  for (const match of text.matchAll(DIRECTED)) {
    const name = match[1]
    if (name === undefined) continue
    if (usable.has(name)) {
      if (!addressed.includes(name)) addressed.push(name)
      continue
    }
    /*
     * Reported only for a role that **exists here and cannot answer** — never for any `#word`.
     *
     * The first version reported anything shaped like a role id, which meant `#include` in a
     * pasted C file, and `#define`, and `#main`. A feature that accuses the user of addressing a
     * missing specialist every time they paste code is unusable in the conversations this product
     * is for.
     *
     * So the test is membership, not shape. `#tester` where the tester is assigned but its profile
     * has gone is a real attempt worth answering; `#include` is text. The cost is that a typo —
     * `#reviewr` — passes silently, which is what the picker exists to prevent.
     */
    if (team.some((agent) => agent.role === name) && !unknown.includes(name)) unknown.push(name)
  }

  return { addressed, unknown }
}

/**
 * What the assistant is told, appended to the user's message.
 *
 * Phrased as something already decided rather than as a suggestion: the mode guidance spends its
 * effort on *when a consultation is worth it*, and this is the case where that judgement is not
 * the assistant's to make. It still has to report what came back — a consultation the user asked
 * for and never heard the result of is worse than one that did not happen.
 */
export function describeDirectedRoles(directed: DirectedRoles, team: readonly ResolvedAgent[]): string {
  const lines: string[] = []

  if (directed.addressed.length > 0) {
    const names = directed.addressed.map((role) => `\`${role}\``).join(', ')
    lines.push(
      `The user addressed ${names} directly with #. Consult ${
        directed.addressed.length > 1 ? 'each of them' : 'it'
      } with \`ask_agent\` before you answer — this is not a judgement call about whether a ` +
        'consultation is worth it, they asked. Put the code, error or output they are referring ' +
        'to in the question, and say plainly in your reply what came back and whether you agree.',
    )
  }

  if (directed.unknown.length > 0) {
    const usable = team.filter((agent) => agent.available).map((agent) => agent.role)
    lines.push(
      `The user wrote ${directed.unknown.map((role) => `#${role}`).join(', ')}, which ${
        directed.unknown.length > 1 ? 'are not roles' : 'is not a role'
      } that can answer here. ${
        usable.length > 0
          ? `Available: ${usable.join(', ')}. Say so and carry on with the request.`
          : 'No specialists are assigned. Say so, mention Settings → Agents, and carry on.'
      }`,
    )
  }

  return lines.join('\n\n')
}
