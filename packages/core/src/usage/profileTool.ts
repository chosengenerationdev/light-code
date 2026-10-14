import { z } from 'zod'
import type { Tool } from '../tools/types.js'
import { cleanProfile, type UsageProfile } from './store.js'

/**
 * Who the user is, for the usage dashboard: a display name and team instead of a login name.
 *
 * **The agent fills it from a user-info tool the user already has** (asked for: "if a tool is
 * available to find user info, the agent should use it to enrich user details"). The host never
 * calls that tool itself - it is an MCP or Python tool, and calling it outside the conversation would
 * run something with no approval and nobody watching. So the agent calls it the ordinary way, then
 * passes what it returned here, and the approval shows exactly what will be written where (invariant
 * 8). `edit` group: it writes to the shared store, which every colleague reads.
 */

const params = z.object({
  displayName: z.string().max(200).optional().describe('The person\'s full name as the tool gave it.'),
  email: z.string().max(200).optional(),
  team: z.string().max(200).optional().describe('Team or desk.'),
  department: z.string().max(200).optional(),
  title: z.string().max(200).optional().describe('Job title.'),
  location: z.string().max(200).optional(),
  source: z.string().max(200).optional().describe('The tool the details came from.'),
})

export const RECORD_USER_PROFILE = 'record_user_profile'

/** Tools whose names say they answer "who is this user". `usage.userInfoTool` names one explicitly. */
const USER_INFO_NAME = /(^|_|__)(who_?am_?i|current_?user|user_?info|user_?details|user_?profile|my_?profile|employee(_?(info|details|lookup|profile))?|get_?user|lookup_?user|find_?user|people_?lookup|identity)($|_)/i

export function userInfoToolCandidates(names: readonly string[], configured?: string): string[] {
  const wanted = configured?.trim()
  if (wanted !== undefined && wanted.length > 0) {
    const found = names.find((name) => name === wanted || name === `py__${wanted}` || name.endsWith(`__${wanted}`))
    return found !== undefined ? [found] : []
  }
  return names.filter((name) => name !== RECORD_USER_PROFILE && USER_INFO_NAME.test(name)).slice(0, 3)
}

/** Skills whose names say they look users up (`who-am-i`, `user-info`, ...), for when no tool does. */
export function userInfoSkillCandidates(skills: readonly { name: string; filePath: string }[]): { name: string; filePath: string }[] {
  return skills.filter((skill) => USER_INFO_NAME.test(skill.name.replace(/-/g, '_'))).slice(0, 2)
}

/**
 * The standing instruction - the *second* way to learn who the user is. The company directory comes first
 * (`usage/directory.ts`), read in the background; this appears only when that found nothing (no domain,
 * not Windows, not listed), while collecting, while nothing recent is recorded, and while a tool or a skill
 * exists to ask. So it costs nothing on every other turn and disappears once done.
 */
export function userProfileGuidance(
  user: string,
  tools: readonly string[],
  skills: readonly { name: string; filePath: string }[] = [],
): string {
  const ways = [
    ...tools.map((name) => `call \`${name}\``),
    ...skills.map((skill) => `read the skill "${skill.name}" (${skill.filePath}) and follow it with your own tools`),
  ]
  return [
    '## Usage dashboard: the user\'s details',
    `Usage statistics for the team dashboard are filed under the login "${user}", which colleagues cannot read as a person, and the company directory did not say who that is.`,
    `Once in this conversation, before other work: ${ways.join(', or ')} to look up the current user ("${user}"),`,
    `then call \`${RECORD_USER_PROFILE}\` with the name, email, team, department, title and location found and \`source\` set to the tool or skill used.`,
    'Pass only what was found - never guess a field. If it needs input you do not have, or fails, skip this and carry on; do not ask the user about it.',
  ].join('\n')
}

export function createRecordUserProfileTool(options: {
  user: () => string
  destination: () => string | undefined
  save: (profile: UsageProfile) => Promise<void>
}): Tool<z.infer<typeof params>> {
  const describe = (profile: UsageProfile): string =>
    Object.entries(profile)
      .map(([field, value]) => `  ${field}: ${String(value)}`)
      .join('\n')
  return {
    name: RECORD_USER_PROFILE,
    group: 'edit',
    description:
      'Records who the current user is (name, team, ...) for the team usage dashboard, from what a user-info tool returned. ' +
      'Only fields the tool gave; never invented.',
    parametersSchema: params,
    async preview(input) {
      const profile = cleanProfile(input)
      return {
        kind: 'text',
        text: `Write these details for "${options.user()}" to ${options.destination() ?? 'the usage store'}, where colleagues see them on the dashboard:\n${describe(profile)}`,
      }
    },
    async execute(input) {
      const destination = options.destination()
      if (destination === undefined) return { content: 'Usage is not being collected, so there is nowhere to record these details.', isError: true }
      const profile = { ...cleanProfile(input), updated: new Date().toISOString() }
      if (Object.keys(profile).length <= 1) return { content: 'Nothing to record: no details were given.', isError: true }
      await options.save(profile)
      return { content: `Recorded for "${options.user()}" in ${destination}:\n${describe(profile)}` }
    },
  }
}
