import { z } from 'zod'
import type { Tool } from '../tools/types.js'
import { computeDashboard, type InventoryItem, type UsageDashboard, type UsageScope } from './dashboard.js'
import type { UsageEvent } from './events.js'
import { shardSegment, type UsageProfile } from './store.js'

/**
 * The usage statistics as a tool, so the user can ask the assistant for metrics the dashboard does not
 * draw ("which skills does the Rates team use that FX never touches", "average tool time per project by
 * week") - asked for directly.
 *
 * It reads exactly what the dashboard reads, through the same loader in the bridge (`gatherUsage`), so a
 * number the assistant quotes cannot differ from the one on the page. `events` returns raw rows as JSON
 * records; when there are many, the result is saved and its handle can be passed to `dataframe` as a
 * `result` source, which is how arbitrary grouping, joining and pivoting is done without retyping a row.
 *
 * Read only. The data are names, times and outcomes - never arguments - plus the directory names the
 * dashboard already shows.
 */

export interface UsageData {
  events: UsageEvent[]
  profiles: Record<string, UsageProfile>
  storeLabel: string
  storeProblem?: string | undefined
}

export interface UsageStatsDeps {
  /** The events of `[from, to]` and the period before it, with everyone's profiles - or why not. */
  gather: (from: number, to: number) => Promise<UsageData | { problem: string }>
  inventory: () => Promise<InventoryItem[]>
  me: () => string
}

const DAY = 86_400_000

const params = z.object({
  action: z
    .enum(['summary', 'events', 'inventory', 'people'])
    .describe(
      'summary: the dashboard as text - totals with the previous period, top skills and tools, leaderboard, problems, unused. ' +
        'events: raw usage rows (time, user, name, team, kind, skill or tool, author, project, failed, ms) as JSON records - for custom metrics, ' +
        'pass the result (or its saved handle) to `dataframe`. inventory: every installed skill and Python tool with author, version, updated, location. ' +
        'people: who each user is (name, team, title, location) from the company directory and recorded profiles.',
    ),
  days: z.number().int().min(1).max(3660).optional().describe('The last N days (default 30). Ignored when `from` is given.'),
  from: z.string().optional().describe('Start date, YYYY-MM-DD (inclusive).'),
  to: z.string().optional().describe('End date, YYYY-MM-DD (inclusive; default today).'),
  scope: z.enum(['me', 'team']).optional().describe('me: only the current user\'s use. Default team.'),
  user: z.string().optional().describe('events: only this user (login or display name, any case).'),
  kind: z.enum(['skill', 'tool']).optional().describe('events: only skill uses or only tool calls.'),
  name: z.string().optional().describe('events: only skills or tools whose name contains this (any case).'),
  team: z.string().optional().describe('events: only people in this team or department (any case).'),
  limit: z.number().int().min(1).max(200_000).optional().describe('events: at most this many rows, newest first (default 20000).'),
})

export type UsageStatsParams = z.infer<typeof params>

/** The range a call asks for: `from`/`to` dates, or the last `days`, ending now. */
export function statsRange(input: Pick<UsageStatsParams, 'days' | 'from' | 'to'>, now = Date.now()): { from: number; to: number } | { problem: string } {
  const parse = (value: string, endOfDay: boolean): number => Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}Z`)
  const to = input.to !== undefined ? parse(input.to, true) : now
  if (!Number.isFinite(to)) return { problem: `"${String(input.to)}" is not a date. Use YYYY-MM-DD.` }
  if (input.from !== undefined) {
    const from = parse(input.from, false)
    if (!Number.isFinite(from)) return { problem: `"${input.from}" is not a date. Use YYYY-MM-DD.` }
    if (from > to) return { problem: '`from` is after `to`.' }
    return { from, to }
  }
  return { from: to - (input.days ?? 30) * DAY, to }
}

function profileFor(profiles: Record<string, UsageProfile>, user: string): UsageProfile | undefined {
  return profiles[shardSegment(user)] ?? profiles[shardSegment(user).toLowerCase()]
}

const pct = (value: number, previous: number): string => {
  if (previous === 0) return value === 0 ? '' : ' (new)'
  const change = Math.round(((value - previous) / previous) * 100)
  return ` (${change >= 0 ? '+' : ''}${String(change)}% vs previous)`
}

/** The dashboard as compact Markdown - what the page shows, in words. */
export function renderSummary(d: UsageDashboard, storeLabel: string): string {
  const name = (user: string, display?: string): string => (display !== undefined ? `${display} (${user})` : user)
  const lines: string[] = [
    `# Usage ${d.scope === 'me' ? `for ${d.me}` : 'for the team'}, ${new Date(d.from).toISOString().slice(0, 10)} to ${new Date(d.to).toISOString().slice(0, 10)}`,
    `From ${storeLabel}. ${String(d.eventsInStore)} events in range.`,
    '',
    `- Uses: ${String(d.totals.uses.value)}${pct(d.totals.uses.value, d.totals.uses.previous)}`,
    `- Skill uses: ${String(d.totals.skillUses.value)}${pct(d.totals.skillUses.value, d.totals.skillUses.previous)}; skills in use ${String(d.totals.skillsUsed.value)} of ${String(d.inventory.skills)} installed`,
    `- Tool calls: ${String(d.totals.toolUses.value)}${pct(d.totals.toolUses.value, d.totals.toolUses.previous)}; failed ${String(d.totals.failures.value)}`,
    `- Active people: ${String(d.totals.people.value)}${pct(d.totals.people.value, d.totals.people.previous)}`,
    `- Your contribution: ${String(d.myImpact.skills)} skills and ${String(d.myImpact.tools)} tools, used ${String(d.myImpact.uses)} times by ${String(d.myImpact.reached)} people`,
  ]
  const table = (title: string, header: string, rows: string[]): void => {
    if (rows.length === 0) return
    lines.push('', `## ${title}`, header, `|${header.split('|').slice(1, -1).map(() => '---').join('|')}|`, ...rows)
  }
  table(
    'Most used skills',
    '| Skill | Uses | Previous | People | Author |',
    d.topSkills.slice(0, 15).map((item) => `| ${item.label} | ${String(item.uses)} | ${String(item.previous)} | ${String(item.users)} | ${item.author ?? ''} |`),
  )
  table(
    'Most used tools',
    '| Tool | Calls | Failed | People | Avg ms |',
    d.topTools.slice(0, 15).map((item) => `| ${item.label} | ${String(item.uses)} | ${String(item.failures)} | ${String(item.users)} | ${item.averageMs !== undefined ? String(item.averageMs) : ''} |`),
  )
  table(
    'Leaderboard',
    '| Author | Team | Skills | Tools | Added in range | Updated in range | Uses of their work | People reached | Impact |',
    d.contributors.slice(0, 15).map((c) => `| ${name(c.author, c.displayName)} | ${c.team ?? ''} | ${String(c.skills)} | ${String(c.tools)} | ${String(c.added)} | ${String(c.updated)} | ${String(c.uses)} | ${String(c.reached)} | ${String(c.impact)} |`),
  )
  if (d.scope === 'team') {
    table(
      'People',
      '| Person | Team | Uses | Skills | Favourite skill |',
      d.people.slice(0, 20).map((p) => `| ${name(p.user, p.displayName)} | ${p.team ?? ''} | ${String(p.uses)} | ${String(p.skills)} | ${p.favourite ?? ''} |`),
    )
    table('Teams', '| Team | People | Uses | Skill uses | Top skill |', d.teams.map((t) => `| ${t.team} | ${String(t.people)} | ${String(t.uses)} | ${String(t.skillUses)} | ${t.topSkill ?? ''} |`))
  }
  if (d.problems.length > 0) {
    lines.push('', '## Needs attention')
    for (const problem of d.problems) lines.push(`- **${problem.severity}**: ${problem.title} - ${problem.items.slice(0, 8).map((item) => item.name).join(', ')}${problem.items.length > 8 ? ', ...' : ''}`)
  }
  if (d.unused.length > 0) {
    lines.push('', `## Unused by anybody in range (${String(d.unused.length)})`)
    lines.push(d.unused.slice(0, 30).map((item) => `${item.kind} ${item.name}${item.stale ? ' (stale)' : ''}`).join(', ') + (d.unused.length > 30 ? ', ...' : ''))
  }
  return lines.join('\n')
}

export function createUsageStatsTool(deps: UsageStatsDeps): Tool<UsageStatsParams> {
  return {
    name: 'usage_stats',
    group: 'read',
    description:
      'The team usage statistics behind Settings → Usage: which skills and tools are used, by whom, when, who wrote them, and what is unused or duplicated. ' +
      'Use `summary` for the dashboard in words; for any other metric, get `events` (or `inventory`, `people`) and compute it with `dataframe` - ' +
      'pass the rows, or the saved result\'s handle as a `result` source, and group, join, pivot in SQL.',
    parametersSchema: params,
    async execute(input) {
      const range = statsRange(input)
      if ('problem' in range) return { content: range.problem, isError: true }

      if (input.action === 'inventory') {
        const items = await deps.inventory()
        return {
          content: JSON.stringify(
            items.map((item) => ({
              kind: item.kind,
              name: item.name,
              author: item.author ?? null,
              project: item.project ?? null,
              version: item.version ?? null,
              updated: item.updated ?? null,
              location: item.location,
              deletableHere: item.deletable,
              notLoaded: item.issue ?? null,
            })),
          ),
        }
      }

      const data = await deps.gather(range.from, range.to)
      if ('problem' in data) return { content: `Usage statistics are not available: ${data.problem}`, isError: true }
      const note = data.storeProblem !== undefined ? `\n\nNote: ${data.storeProblem}` : ''

      if (input.action === 'people') {
        const users = new Set<string>()
        for (const event of data.events) {
          users.add(event.u)
          if (event.a !== undefined) users.add(event.a)
        }
        const rows = [...users].sort().map((user) => {
          const profile = profileFor(data.profiles, user)
          return {
            user,
            displayName: profile?.displayName ?? null,
            email: profile?.email ?? null,
            team: profile?.team ?? profile?.department ?? null,
            title: profile?.title ?? null,
            location: profile?.location ?? null,
            source: profile?.source ?? null,
          }
        })
        return { content: JSON.stringify(rows) + note }
      }

      const me = deps.me()
      const scope: UsageScope = input.scope ?? 'team'
      if (input.action === 'summary') {
        const dashboard = computeDashboard({ events: data.events, inventory: await deps.inventory(), scope, me, from: range.from, to: range.to, profiles: data.profiles })
        return { content: renderSummary(dashboard, data.storeLabel) + note }
      }

      // events
      const contains = (value: string | undefined, wanted: string | undefined): boolean => wanted === undefined || (value ?? '').toLowerCase().includes(wanted.toLowerCase())
      const rows = data.events
        .filter((event) => event.t >= range.from && event.t <= range.to)
        .filter((event) => scope === 'team' || event.u === me)
        .filter((event) => input.kind === undefined || event.k === input.kind)
        .filter((event) => contains(event.n, input.name))
        .map((event) => {
          const profile = profileFor(data.profiles, event.u)
          return { event, profile }
        })
        .filter(({ event, profile }) => input.user === undefined || [event.u, profile?.displayName].some((value) => value !== undefined && value.toLowerCase() === input.user!.toLowerCase()))
        .filter(({ profile }) => input.team === undefined || contains(profile?.team ?? profile?.department, input.team) && (profile?.team ?? profile?.department) !== undefined)
        .sort((a, b) => b.event.t - a.event.t)
        .slice(0, input.limit ?? 20_000)
        .map(({ event, profile }) => ({
          time: new Date(event.t).toISOString(),
          day: new Date(event.t).toISOString().slice(0, 10),
          user: event.u,
          displayName: profile?.displayName ?? null,
          team: profile?.team ?? profile?.department ?? null,
          kind: event.k,
          name: event.k === 'tool' && event.n.startsWith('py__') ? event.n.slice(4) : event.n,
          pythonTool: event.k === 'tool' && event.n.startsWith('py__'),
          author: event.a ?? null,
          project: event.p ?? null,
          failed: event.ok === false,
          ms: event.d ?? null,
        }))
      if (rows.length === 0) return { content: `No usage matched in ${new Date(range.from).toISOString().slice(0, 10)} to ${new Date(range.to).toISOString().slice(0, 10)}.${note}` }
      return { content: JSON.stringify(rows) + note }
    },
  }
}
