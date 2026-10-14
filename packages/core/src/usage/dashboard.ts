import type { UsageEvent } from './events.js'
import { shardSegment, type UsageProfile } from './store.js'

/**
 * The usage dashboard, computed from events and the inventory of what is installed here.
 *
 * Pure, so every number on the page can be tested from fixtures - a dashboard is believed, and a
 * wrong count on one is worse than no count, because somebody deletes a skill on the strength of it.
 * That is also why "unused" is always stated with its range: "never used in the last 7 days" and
 * "never used" are different reasons to delete something.
 */

export interface InventoryItem {
  kind: 'skill' | 'tool'
  /** The skill name, or the Python tool's name without `py__`. */
  name: string
  filePath: string
  description?: string
  author?: string
  project?: string
  /** ISO time from the item's own label. */
  updated?: string
  /** From the label: 1 for the first save, so an item updated in range at version 1 is new. */
  version?: number
  /** True when it lives in the folder Light Code writes to, so the dashboard may offer to delete it. */
  deletable: boolean
  /** Where it lives, for people: "this project", "shared folder", "bucket". */
  location: string
  /** Of the file's bytes, to find the same content under two names and two contents under one name. */
  contentHash?: string
  /** Why a Python tool is not loaded, when it is not. */
  issue?: string
}

export type UsageScope = 'me' | 'team'

export interface DashboardInput {
  events: readonly UsageEvent[]
  inventory: readonly InventoryItem[]
  scope: UsageScope
  me: string
  from: number
  to: number
  /** For the hour-of-week heat map: the viewer's offset, `Date.getTimezoneOffset()` minutes. */
  timezoneOffsetMinutes?: number
  /** Who each user is, keyed by `shardSegment(user)` - from a user-info tool. */
  profiles?: Readonly<Record<string, UsageProfile>>
}

export interface CountWithPrevious {
  value: number
  previous: number
}

export interface RankedItem {
  kind: 'skill' | 'tool'
  name: string
  /** Displayed name: a Python tool without its `py__`. */
  label: string
  uses: number
  previous: number
  users: number
  failures: number
  lastUsed: number
  averageMs?: number
  author?: string
  /** Uses per timeline bucket, for the row's sparkline. */
  spark: number[]
  installed: boolean
  filePath?: string
  deletable?: boolean
}

export interface Person {
  user: string
  displayName?: string
  team?: string
  title?: string
  uses: number
  skills: number
  tools: number
  favourite?: string
  lastActive: number
}

export interface Contributor {
  author: string
  displayName?: string
  team?: string
  skills: number
  tools: number
  /** Uses of their skills and tools in the range, by anybody. */
  uses: number
  /** How many different people used their work. */
  reached: number
  /** Uses x people reached: how far their work travels, not just how much there is. */
  impact: number
  /** Skills and tools they added (version 1) in the range, and updated (later versions) in the range. */
  added: number
  updated: number
  lastUpdated?: string
}

export interface ProblemItem {
  kind: 'skill' | 'tool'
  name: string
  filePath?: string
  deletable?: boolean
  note?: string
}

export interface Problem {
  severity: 'error' | 'warning' | 'info'
  id: string
  title: string
  detail: string
  items: ProblemItem[]
}

export interface UnusedItem {
  kind: 'skill' | 'tool'
  name: string
  filePath: string
  author?: string
  updated?: string
  location: string
  deletable: boolean
  /** Not updated for over a year, as well as unused. */
  stale: boolean
}

export interface UsageDashboard {
  scope: UsageScope
  me: string
  from: number
  to: number
  totals: {
    uses: CountWithPrevious
    skillUses: CountWithPrevious
    toolUses: CountWithPrevious
    failures: CountWithPrevious
    people: CountWithPrevious
    skillsUsed: CountWithPrevious
    toolsUsed: CountWithPrevious
  }
  timeline: { unit: 'hour' | 'day' | 'week' | 'month'; buckets: { start: number; skills: number; tools: number; failures: number }[] }
  /** `[weekday 0=Sunday][hour]`, in the viewer's time zone. */
  heatmap: number[][]
  topSkills: RankedItem[]
  topTools: RankedItem[]
  /** Skills rising fastest against the previous period. */
  rising: RankedItem[]
  people: Person[]
  /** Usage by team, from profiles. Empty when nobody's team is known. */
  teams: { team: string; people: number; uses: number; skillUses: number; topSkill?: string }[]
  contributors: Contributor[]
  /** The viewer's own work, used by anybody (team events only - local events are the viewer's). */
  myImpact: { skills: number; tools: number; uses: number; reached: number; usedByOthers: number }
  unused: UnusedItem[]
  recent: { kind: 'skill' | 'tool'; name: string; author?: string; updated: string; location: string }[]
  problems: Problem[]
  inventory: { skills: number; tools: number; authors: number }
  /** How many events the range held, before scope filtering - "0" with a store is worth knowing. */
  eventsInStore: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

const toolLabel = (name: string): string => (name.startsWith('py__') ? name.slice(4) : name)

function bucketUnit(span: number): UsageDashboard['timeline']['unit'] {
  if (span <= 2 * DAY) return 'hour'
  if (span <= 92 * DAY) return 'day'
  if (span <= 400 * DAY) return 'week'
  return 'month'
}

/** Bucket starts covering `[from, to]`, in UTC so every viewer's bars agree. */
function bucketStarts(from: number, to: number, unit: UsageDashboard['timeline']['unit']): number[] {
  const starts: number[] = []
  const start = new Date(from)
  if (unit === 'hour') start.setUTCMinutes(0, 0, 0)
  else {
    start.setUTCHours(0, 0, 0, 0)
    if (unit === 'week') start.setUTCDate(start.getUTCDate() - start.getUTCDay())
    if (unit === 'month') start.setUTCDate(1)
  }
  const cursor = new Date(start)
  while (cursor.getTime() <= to && starts.length < 2000) {
    starts.push(cursor.getTime())
    if (unit === 'hour') cursor.setUTCHours(cursor.getUTCHours() + 1)
    else if (unit === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1)
    else if (unit === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7)
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return starts
}

function bucketIndex(starts: readonly number[], t: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= t) low = middle
    else high = middle - 1
  }
  return low
}

/** `deploy_app`, `Deploy-App` and `deployapp` are one name to a person. */
export function normalisedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function key(kind: string, name: string): string {
  return `${kind}:${name}`
}

/** The inventory entry an event is about: Python tools are registered as `py__name`. */
function inventoryKey(event: Pick<UsageEvent, 'k' | 'n'>): string {
  return event.k === 'tool' && event.n.startsWith('py__') ? key('tool', event.n.slice(4)) : key(event.k, event.n)
}

function count(events: readonly UsageEvent[]): {
  uses: number
  skillUses: number
  toolUses: number
  failures: number
  people: number
  skillsUsed: number
  toolsUsed: number
} {
  const people = new Set<string>()
  const skills = new Set<string>()
  const tools = new Set<string>()
  let skillUses = 0
  let toolUses = 0
  let failures = 0
  for (const event of events) {
    people.add(event.u)
    if (event.k === 'skill') {
      skillUses++
      skills.add(event.n)
    } else {
      toolUses++
      tools.add(event.n)
    }
    if (event.ok === false) failures++
  }
  return { uses: events.length, skillUses, toolUses, failures, people: people.size, skillsUsed: skills.size, toolsUsed: tools.size }
}

export function computeDashboard(input: DashboardInput): UsageDashboard {
  const { from, to, scope, me } = input
  // Exact first, then without case: the directory is asked in lower case, labels keep theirs.
  const profileOf = (user: string): UsageProfile | undefined =>
    input.profiles?.[shardSegment(user)] ?? input.profiles?.[shardSegment(user).toLowerCase()]
  /** Name and team for a row, when a profile says them. */
  const who = (user: string): { displayName?: string; team?: string; title?: string } => {
    const profile = profileOf(user)
    return {
      ...(profile?.displayName !== undefined ? { displayName: profile.displayName } : {}),
      ...(profile?.team !== undefined ? { team: profile.team } : profile?.department !== undefined ? { team: profile.department } : {}),
      ...(profile?.title !== undefined ? { title: profile.title } : {}),
    }
  }
  const span = Math.max(HOUR, to - from)
  const previousFrom = from - span
  const inScope = (event: UsageEvent): boolean => scope === 'team' || event.u === me
  const current = input.events.filter((event) => event.t >= from && event.t <= to && inScope(event))
  const previous = input.events.filter((event) => event.t >= previousFrom && event.t < from && inScope(event))
  const nowCount = count(current)
  const thenCount = count(previous)
  const pair = (name: keyof typeof nowCount): CountWithPrevious => ({ value: nowCount[name], previous: thenCount[name] })

  // Timeline.
  const unit = bucketUnit(span)
  const starts = bucketStarts(from, to, unit)
  const buckets = starts.map((start) => ({ start, skills: 0, tools: 0, failures: 0 }))
  for (const event of current) {
    const bucket = buckets[bucketIndex(starts, event.t)]!
    if (event.k === 'skill') bucket.skills++
    else bucket.tools++
    if (event.ok === false) bucket.failures++
  }

  // Heat map, in the viewer's time zone.
  const offset = (input.timezoneOffsetMinutes ?? 0) * 60_000
  const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  for (const event of current) {
    const local = new Date(event.t - offset)
    heatmap[local.getUTCDay()]![local.getUTCHours()]!++
  }

  // Inventory lookups.
  const installed = new Map<string, InventoryItem>()
  for (const item of input.inventory) if (!installed.has(key(item.kind, item.name))) installed.set(key(item.kind, item.name), item)

  // Ranked items.
  const ranked = new Map<string, RankedItem & { people: Set<string>; durations: number[] }>()
  for (const event of current) {
    const id = key(event.k, event.n)
    let entry = ranked.get(id)
    if (entry === undefined) {
      const item = installed.get(inventoryKey(event))
      const author = event.a ?? item?.author
      entry = {
        kind: event.k,
        name: event.n,
        label: event.k === 'tool' ? toolLabel(event.n) : event.n,
        uses: 0,
        previous: 0,
        users: 0,
        failures: 0,
        lastUsed: 0,
        spark: new Array<number>(buckets.length).fill(0),
        installed: item !== undefined,
        ...(author !== undefined ? { author } : {}),
        ...(item !== undefined ? { filePath: item.filePath, deletable: item.deletable } : {}),
        people: new Set<string>(),
        durations: [],
      }
      ranked.set(id, entry)
    }
    entry.uses++
    entry.people.add(event.u)
    if (event.ok === false) entry.failures++
    entry.lastUsed = Math.max(entry.lastUsed, event.t)
    if (event.d !== undefined) entry.durations.push(event.d)
    entry.spark[bucketIndex(starts, event.t)]!++
  }
  for (const event of previous) {
    const entry = ranked.get(key(event.k, event.n))
    if (entry !== undefined) entry.previous++
  }
  const finished: RankedItem[] = [...ranked.values()].map(({ people, durations, ...rest }) => ({
    ...rest,
    users: people.size,
    ...(durations.length > 0 ? { averageMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) } : {}),
  }))
  const byUses = (a: RankedItem, b: RankedItem): number => b.uses - a.uses || b.lastUsed - a.lastUsed
  const topSkills = finished.filter((item) => item.kind === 'skill').sort(byUses).slice(0, 15)
  const topTools = finished.filter((item) => item.kind === 'tool').sort(byUses).slice(0, 15)
  const rising = finished
    .filter((item) => item.kind === 'skill' && item.uses >= 3 && item.uses > item.previous)
    .sort((a, b) => b.uses - b.previous - (a.uses - a.previous))
    .slice(0, 5)

  // People.
  const personMap = new Map<string, { uses: number; skills: Set<string>; tools: Set<string>; counts: Map<string, number>; last: number }>()
  for (const event of current) {
    const person = personMap.get(event.u) ?? { uses: 0, skills: new Set(), tools: new Set(), counts: new Map(), last: 0 }
    person.uses++
    ;(event.k === 'skill' ? person.skills : person.tools).add(event.n)
    if (event.k === 'skill') person.counts.set(event.n, (person.counts.get(event.n) ?? 0) + 1)
    person.last = Math.max(person.last, event.t)
    personMap.set(event.u, person)
  }
  const people: Person[] = [...personMap.entries()]
    .map(([user, person]) => {
      const favourite = [...person.counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      return {
        user,
        ...who(user),
        uses: person.uses,
        skills: person.skills.size,
        tools: person.tools.size,
        ...(favourite !== undefined ? { favourite } : {}),
        lastActive: person.last,
      }
    })
    .sort((a, b) => b.uses - a.uses)

  // Contributors: authors of what is installed here, plus authors named on events (colleagues' work).
  const contributorMap = new Map<string, { skills: Set<string>; tools: Set<string>; uses: number; reached: Set<string>; added: number; updated: number; lastUpdated?: string }>()
  const contributor = (author: string) => {
    let entry = contributorMap.get(author)
    if (entry === undefined) {
      entry = { skills: new Set(), tools: new Set(), uses: 0, reached: new Set(), added: 0, updated: 0 }
      contributorMap.set(author, entry)
    }
    return entry
  }
  for (const item of input.inventory) {
    if (item.author === undefined) continue
    const entry = contributor(item.author)
    ;(item.kind === 'skill' ? entry.skills : entry.tools).add(item.name)
    if (item.updated !== undefined && (entry.lastUpdated === undefined || item.updated > entry.lastUpdated)) entry.lastUpdated = item.updated
    // Contribution in the period: a label dated inside the range, new at version 1, an update after.
    const when = item.updated !== undefined ? Date.parse(item.updated) : NaN
    if (Number.isFinite(when) && when >= from && when <= to) {
      if (item.version === undefined || item.version <= 1) entry.added++
      else entry.updated++
    }
  }
  // Contribution counts every use of the work in range, whoever's scope - a contributor's reach is a team fact.
  const allInRange = input.events.filter((event) => event.t >= from && event.t <= to)
  for (const event of allInRange) {
    const author = event.a ?? installed.get(inventoryKey(event))?.author
    if (author === undefined) continue
    const entry = contributor(author)
    entry.uses++
    entry.reached.add(event.u)
    if (event.k === 'skill') entry.skills.add(event.n)
    else if (event.n.startsWith('py__')) entry.tools.add(event.n.slice(4))
  }
  const contributors: Contributor[] = [...contributorMap.entries()]
    .map(([author, entry]) => ({
      author,
      ...(() => {
        const person = who(author)
        return {
          ...(person.displayName !== undefined ? { displayName: person.displayName } : {}),
          ...(person.team !== undefined ? { team: person.team } : {}),
        }
      })(),
      skills: entry.skills.size,
      tools: entry.tools.size,
      uses: entry.uses,
      reached: entry.reached.size,
      impact: entry.uses * entry.reached.size,
      added: entry.added,
      updated: entry.updated,
      ...(entry.lastUpdated !== undefined ? { lastUpdated: entry.lastUpdated } : {}),
    }))
    .sort((a, b) => b.skills + b.tools - (a.skills + a.tools) || b.uses - a.uses)

  const mine = contributorMap.get(me)
  const usedByOthers = new Set(
    allInRange.filter((event) => event.u !== me && (event.a ?? installed.get(inventoryKey(event))?.author) === me).map((event) => event.u),
  ).size
  const myImpact = {
    skills: mine?.skills.size ?? 0,
    tools: mine?.tools.size ?? 0,
    uses: mine?.uses ?? 0,
    reached: mine?.reached.size ?? 0,
    usedByOthers,
  }

  // Unused - judged on the whole team's events in range, so "unused" never means "unused by me".
  const usedKeys = new Set(allInRange.map(inventoryKey))
  const yearAgo = to - 365 * DAY
  const unused: UnusedItem[] = input.inventory
    .filter((item) => !usedKeys.has(key(item.kind, item.name)))
    .map((item) => ({
      kind: item.kind,
      name: item.name,
      filePath: item.filePath,
      ...(item.author !== undefined ? { author: item.author } : {}),
      ...(item.updated !== undefined ? { updated: item.updated } : {}),
      location: item.location,
      deletable: item.deletable,
      stale: item.updated !== undefined && Date.parse(item.updated) < yearAgo,
    }))
    .sort((a, b) => Number(b.stale) - Number(a.stale) || (a.updated ?? '').localeCompare(b.updated ?? ''))

  const recent = input.inventory
    .filter((item) => item.updated !== undefined && Date.parse(item.updated) >= from && Date.parse(item.updated) <= to)
    .map((item) => ({
      kind: item.kind,
      name: item.name,
      ...(item.author !== undefined ? { author: item.author } : {}),
      updated: item.updated!,
      location: item.location,
    }))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, 12)

  const problems = findProblems(input.inventory, finished, allInRange, installed)

  // Teams, from profiles: who works where is the one thing a login name never says.
  const teamMap = new Map<string, { people: Set<string>; uses: number; skillUses: number; skills: Map<string, number> }>()
  for (const event of current) {
    const team = who(event.u).team
    if (team === undefined) continue
    const entry = teamMap.get(team) ?? { people: new Set(), uses: 0, skillUses: 0, skills: new Map() }
    entry.people.add(event.u)
    entry.uses++
    if (event.k === 'skill') {
      entry.skillUses++
      entry.skills.set(event.n, (entry.skills.get(event.n) ?? 0) + 1)
    }
    teamMap.set(team, entry)
  }
  const teams = [...teamMap.entries()]
    .map(([team, entry]) => {
      const topSkill = [...entry.skills.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      return { team, people: entry.people.size, uses: entry.uses, skillUses: entry.skillUses, ...(topSkill !== undefined ? { topSkill } : {}) }
    })
    .sort((a, b) => b.uses - a.uses)

  return {
    scope,
    me,
    from,
    to,
    totals: {
      uses: pair('uses'),
      skillUses: pair('skillUses'),
      toolUses: pair('toolUses'),
      failures: pair('failures'),
      people: pair('people'),
      skillsUsed: pair('skillsUsed'),
      toolsUsed: pair('toolsUsed'),
    },
    timeline: { unit, buckets },
    heatmap,
    topSkills,
    topTools,
    rising,
    people,
    teams,
    contributors,
    myImpact,
    unused,
    recent,
    problems,
    inventory: {
      skills: input.inventory.filter((item) => item.kind === 'skill').length,
      tools: input.inventory.filter((item) => item.kind === 'tool').length,
      authors: new Set(input.inventory.map((item) => item.author).filter((author) => author !== undefined)).size,
    },
    eventsInStore: allInRange.length,
  }
}

function asProblemItem(item: InventoryItem, note?: string): ProblemItem {
  return { kind: item.kind, name: item.name, filePath: item.filePath, deletable: item.deletable, ...(note !== undefined ? { note } : {}) }
}

/**
 * What somebody should know about the skills and tools themselves.
 *
 * A copy of the same file under the same name in two folders is **not** a problem - that is how a
 * bucket mirror sits beside the folder it publishes from (§12r made identical copies silent for
 * exactly this reason). Different content under one name is, because only the first folder's copy
 * is ever used and nothing on screen says which.
 */
export function findProblems(
  inventory: readonly InventoryItem[],
  ranked: readonly RankedItem[],
  events: readonly UsageEvent[],
  installed: ReadonlyMap<string, InventoryItem>,
): Problem[] {
  const problems: Problem[] = []

  for (const kind of ['skill', 'tool'] as const) {
    const noun = kind === 'skill' ? 'skill' : 'Python tool'
    const items = inventory.filter((item) => item.kind === kind)

    const byName = new Map<string, InventoryItem[]>()
    for (const item of items) byName.set(item.name, [...(byName.get(item.name) ?? []), item])
    const conflicting = [...byName.values()].filter(
      (group) => group.length > 1 && new Set(group.map((item) => item.contentHash ?? item.filePath)).size > 1,
    )
    if (conflicting.length > 0) {
      problems.push({
        severity: 'warning',
        id: `${kind}-name-conflict`,
        title: `${String(conflicting.length)} ${noun} name${conflicting.length === 1 ? ' is' : 's are'} used for different content`,
        detail: `Only the first folder's copy is used. Rename one, or delete the copy nobody should be using.`,
        items: conflicting.flatMap((group) => group.map((item, index) => asProblemItem(item, index === 0 ? `in use (${item.location})` : `hidden (${item.location})`))),
      })
    }

    const byHash = new Map<string, InventoryItem[]>()
    for (const item of items) {
      if (item.contentHash === undefined) continue
      byHash.set(item.contentHash, [...(byHash.get(item.contentHash) ?? []), item])
    }
    const copies = [...byHash.values()].filter((group) => new Set(group.map((item) => item.name)).size > 1)
    if (copies.length > 0) {
      problems.push({
        severity: 'warning',
        id: `${kind}-duplicate-content`,
        title: `${String(copies.length)} ${noun}${copies.length === 1 ? ' exists' : 's exist'} under more than one name`,
        detail: 'Identical content under different names. Keep one name and delete the others, or the assistant may pick either.',
        items: copies.flatMap((group) => group.map((item) => asProblemItem(item, `same content as ${group.filter((other) => other.name !== item.name).map((other) => other.name).join(', ')}`))),
      })
    }

    const byNormal = new Map<string, InventoryItem[]>()
    for (const item of items) byNormal.set(normalisedName(item.name), [...(byNormal.get(normalisedName(item.name)) ?? []), item])
    const similar = [...byNormal.values()].filter((group) => new Set(group.map((item) => item.name)).size > 1)
    if (similar.length > 0) {
      problems.push({
        severity: 'info',
        id: `${kind}-similar-names`,
        title: `${String(similar.length)} set${similar.length === 1 ? '' : 's'} of ${noun}s with near-identical names`,
        detail: 'Names that differ only by case or punctuation. Probably one thing written twice.',
        items: similar.flat().map((item) => asProblemItem(item)),
      })
    }

    const undescribed = items.filter((item) => kind === 'skill' && (item.description ?? '').trim().length === 0)
    if (undescribed.length > 0) {
      problems.push({
        severity: 'info',
        id: 'skill-no-description',
        title: `${String(undescribed.length)} skill${undescribed.length === 1 ? ' has' : 's have'} no description`,
        detail: 'Only the description reaches the assistant until it opens a skill, so a skill without one is rarely found.',
        items: undescribed.map((item) => asProblemItem(item)),
      })
    }

    const unattributed = items.filter((item) => item.author === undefined)
    if (unattributed.length > 0) {
      problems.push({
        severity: 'info',
        id: `${kind}-no-author`,
        title: `${String(unattributed.length)} ${noun}${unattributed.length === 1 ? ' has' : 's have'} no author`,
        detail: 'Contribution counts skip them. Label them in Settings → Project → "Label existing skills and tools".',
        items: unattributed.slice(0, 40).map((item) => asProblemItem(item)),
      })
    }
  }

  const broken = inventory.filter((item) => item.issue !== undefined)
  if (broken.length > 0) {
    problems.push({
      severity: 'error',
      id: 'tool-not-loaded',
      title: `${String(broken.length)} Python tool${broken.length === 1 ? ' is' : 's are'} not loaded`,
      detail: 'Waiting for approval, changed since approval, or failing to import. See Settings → Python.',
      items: broken.map((item) => asProblemItem(item, item.issue)),
    })
  }

  const failing = ranked.filter((item) => item.kind === 'tool' && item.uses >= 3 && item.failures / item.uses >= 0.3)
  if (failing.length > 0) {
    problems.push({
      severity: 'warning',
      id: 'tool-failing',
      title: `${String(failing.length)} tool${failing.length === 1 ? ' fails' : 's fail'} often`,
      detail: 'At least three calls in this range, and three in ten or more failed.',
      items: failing.map((item) => ({
        kind: 'tool' as const,
        name: item.label,
        ...(item.filePath !== undefined ? { filePath: item.filePath } : {}),
        note: `${String(item.failures)} of ${String(item.uses)} failed`,
      })),
    })
  }

  const missing = [...new Set(events.filter((event) => event.k === 'skill' && !installed.has(key('skill', event.n))).map((event) => event.n))]
  if (missing.length > 0) {
    problems.push({
      severity: 'info',
      id: 'skill-not-here',
      title: `${String(missing.length)} skill${missing.length === 1 ? '' : 's'} colleagues use ${missing.length === 1 ? 'is' : 'are'} not installed here`,
      detail: 'Used by somebody in range but absent from this machine. Sync the shared bucket, or ask the author to publish it.',
      items: missing.slice(0, 40).map((name) => ({ kind: 'skill' as const, name })),
    })
  }

  const order = { error: 0, warning: 1, info: 2 }
  return problems.sort((a, b) => order[a.severity] - order[b.severity])
}
