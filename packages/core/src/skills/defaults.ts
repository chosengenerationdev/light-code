/**
 * Defaults for a skill's placeholders.
 *
 * Asked for: "some skills may have placeholders to get user inputs, can we provide a way for user
 * of that skill to declare defaults for those placeholders? so that agent wont have to wait for user
 * input all the time". A skill shared across a team cannot carry one person's answers - the
 * environment they deploy to, their team, their user name - so the answers are the *user's*, stored
 * in their own config (`skillDefaults`, user-scope only) by skill name, and the skill file is never
 * edited.
 *
 * The model is told twice, because either alone was judged too weak for the job of stopping a model
 * that a skill tells to "ask the user for X": once in the prompt (beside the skill list, so it knows
 * before it reads), and again with the skill's text when `read_file` returns it (where the "ask"
 * instruction is - `skillDefaultsReadNote`).
 *
 * Defaults are answers, never permission: acting on a filled-in value still goes through the
 * approval gate on its own terms, exactly like an `ask_user_form` answer (§6b).
 */

export type SkillDefaults = Record<string, Record<string, string>>

/** A placeholder name: a word, perhaps dotted or dashed, short enough to be a name and not prose. */
const NAME = '[A-Za-z_][A-Za-z0-9_.-]{0,63}'

/**
 * The placeholders a skill's text appears to have, in order of first appearance.
 *
 * Two spellings, because both are what people write: `{{ name }}` (Mustache, Jinja, most template
 * habits) and `<NAME>` in capitals (`<USERNAME>`, `<YOUR_TEAM>` - documentation's habit). Lower-case
 * `<name>` is not taken: it is HTML and generics (`List<string>`), and offering those as questions
 * would bury the real ones. `${name}` is not taken either: in a skill it is nearly always a shell or
 * JavaScript variable. A placeholder written some other way can still be given a default by name in
 * the tab - detection only suggests.
 */
export function findPlaceholders(text: string): string[] {
  const found: string[] = []
  const add = (name: string): void => {
    if (!found.includes(name)) found.push(name)
  }
  const pattern = new RegExp(`\\{\\{\\s*(${NAME})\\s*\\}\\}|<([A-Z][A-Z0-9_]{1,63})>`, 'g')
  for (const match of text.matchAll(pattern)) add(match[1] ?? match[2] ?? '')
  return found.filter((name) => name.length > 0).slice(0, 50)
}

/** Only entries with a name and a value: an empty box is "no default", never "the empty string". */
export function cleanSkillDefaults(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    const name = key.trim()
    if (name.length === 0 || value.trim().length === 0) continue
    out[name] = value.trim()
  }
  return out
}

function lines(values: Record<string, string>): string[] {
  return Object.entries(values).map(([name, value]) => `  - ${name} = ${value}`)
}

/**
 * The prompt section, for the skills that exist and have defaults. Empty otherwise, so a user who
 * never sets one pays nothing. Stable within a turn (it is config), so the cache rule holds (§12).
 */
export function renderSkillDefaults(defaults: SkillDefaults | undefined, skillNames: readonly string[]): string {
  const entries = Object.entries(defaults ?? {})
    .filter(([name, values]) => skillNames.includes(name) && Object.keys(values).length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return ''
  return [
    '## Skill defaults',
    '',
    'The user has answered some skills\' placeholders in advance. When you follow one of these skills,',
    'use these values wherever the skill asks for that input - do not stop to ask the user for them.',
    'Say briefly which defaults you used. Ask only for inputs that have no default here, or when the',
    "user's request in this conversation gives a different value (theirs wins).",
    '',
    ...entries.flatMap(([name, values]) => [`- ${name}:`, ...lines(values)]),
  ].join('\n')
}

/** Appended to `read_file`'s result for a skill with defaults, where the skill's "ask" instruction is. */
export function skillDefaultsReadNote(skillName: string, values: Record<string, string> | undefined): string | undefined {
  if (values === undefined || Object.keys(values).length === 0) return undefined
  return [
    '',
    `[Defaults the user set for the "${skillName}" skill - use them instead of asking for these inputs:`,
    ...lines(values),
    ' Ask only for inputs not listed, or if the user gave a different value in this conversation.]',
  ].join('\n')
}
