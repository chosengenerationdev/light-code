import type { UsageHelper, UsageProfile } from './store.js'

/**
 * Who a login name is, from the company directory - the primary source of people's names and teams on
 * the usage dashboard (asked for: the built-in Windows lookup first, a skill or Python tool second).
 *
 * Read with Windows' own LDAP client as the signed-in user, through the Rust helper (`directory.rs`,
 * wldap32) - Fire Code's, or the slim one the Windows VS Code package carries. Names go in as JSON and
 * into the filter escaped (RFC 4515). It searches and reads, nothing else, and only the eight fields below.
 *
 * **There is no PowerShell fallback, deliberately** (0.161.0). It ran `powershell -EncodedCommand` with a
 * DirectorySearcher, and that raised a security alert on a managed machine; the machines using the Rust
 * helper for the same lookups raised none. With no helper the lookup is simply unavailable, and the
 * dashboard falls back to profiles recorded by a tool.
 *
 * The second recorded exception to "all traffic through the one HttpClient" (CLAUDE.md §3): directory
 * entries from the machine's own domain, only while usage collection is on.
 */

export interface DirectoryPerson {
  displayName?: string
  email?: string
  department?: string
  title?: string
  location?: string
  company?: string
  account?: string
}

export type DirectoryAnswer =
  | { available: true; people: Record<string, DirectoryPerson>; notFound: string[]; via: 'rust' }
  | { available: false; reason: string; via: 'rust' | 'none' }

const ATTRIBUTE_MAP: readonly [string, keyof DirectoryPerson][] = [
  ['displayName', 'displayName'],
  ['mail', 'email'],
  ['department', 'department'],
  ['title', 'title'],
  ['physicalDeliveryOfficeName', 'location'],
  ['company', 'company'],
  ['sAMAccountName', 'account'],
]

/** RFC 4515: a name inside a filter cannot end the clause or add a wildcard. Same as `directory.rs`. */
export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

function accountPart(name: string): string {
  return name.split('\\').pop() ?? name
}

/** Which asked-for name a directory entry answers, without case - the rules `directory.rs` uses. */
export function entryMatches(entry: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase()
  const account = accountPart(name).toLowerCase()
  const field = (key: string): string | undefined => entry[key]?.toLowerCase()
  const upn = field('userPrincipalName')
  return (
    field('sAMAccountName') === account ||
    upn === wanted ||
    (upn !== undefined && upn.split('@')[0] === account) ||
    field('mail') === wanted ||
    field('displayName') === wanted
  )
}

export function personFromEntry(entry: Record<string, string>): DirectoryPerson {
  const person: DirectoryPerson = {}
  for (const [from, to] of ATTRIBUTE_MAP) {
    const value = entry[from]?.trim()
    if (value !== undefined && value.length > 0) person[to] = value.slice(0, 200)
  }
  return person
}

/** A directory entry as the dashboard's profile: the department is the team, the directory is the source. */
export function profileFromPerson(person: DirectoryPerson): UsageProfile {
  return {
    ...(person.displayName !== undefined ? { displayName: person.displayName } : {}),
    ...(person.email !== undefined ? { email: person.email } : {}),
    ...(person.department !== undefined ? { department: person.department, team: person.department } : {}),
    ...(person.title !== undefined ? { title: person.title } : {}),
    ...(person.location !== undefined ? { location: person.location } : {}),
    source: 'company directory',
  }
}

export async function lookupDirectory(
  names: readonly string[],
  options: { helper?: UsageHelper | undefined; platform?: string } = {},
): Promise<DirectoryAnswer> {
  const wanted = [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0 && name.length <= 200))].slice(0, 500)
  if ((options.platform ?? process.platform) !== 'win32') return { available: false, reason: 'The company directory is read through Windows; this is not Windows.', via: 'none' }
  if (options.helper === undefined) {
    return { available: false, reason: 'The company directory is read through the Rust helper, and none is available here.', via: 'none' }
  }
  if (wanted.length === 0) return { available: true, people: {}, notFound: [], via: 'rust' }

  const answer = await options.helper({ op: 'directory', names: wanted })
  if (answer['ok'] !== true) return { available: false, reason: String(answer['error'] ?? 'The Rust helper has no directory lookup.'), via: 'rust' }
  if (answer['available'] !== true) return { available: false, reason: String(answer['reason'] ?? 'The directory could not be reached.'), via: 'rust' }
  const people: Record<string, DirectoryPerson> = {}
  for (const [name, value] of Object.entries((answer['people'] ?? {}) as Record<string, Record<string, string>>)) {
    // Already in the dashboard's field names; kept to the known ones.
    const person: DirectoryPerson = {}
    for (const [, field] of ATTRIBUTE_MAP) if (typeof value[field] === 'string') person[field] = value[field]
    people[name] = person
  }
  return { available: true, people, notFound: (answer['notFound'] as string[] | undefined) ?? [], via: 'rust' }
}
