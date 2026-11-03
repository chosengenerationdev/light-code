import { z } from 'zod'

import type { Tool, ToolExecutionContext, ToolPreview, ToolResult } from '../tools/types.js'
import type { MonitoringChannel } from './channel.js'
import { checkMonitorRows, describeRowsCheck, MONITOR_TOOL_TEMPLATE } from './rowsCheck.js'

/**
 * The agent's side of Fire Code's monitoring dashboard (asked for: agents create monitoring skills, reuse
 * or create the tools they need, and have "some level of control on the dashboard").
 *
 * - **`monitor_create`** writes a monitor: a skill holding a ` ```monitor ` block, through `write_skill`
 *   itself - so it lands where skills land (personal, or where the team shares them), is published the same
 *   way, and the user approves the exact file. The preview also shows what the engine makes of it: a block it
 *   cannot read is refused before anything is written, and a SQLite or file source is tried for real.
 *   Approving the write approves the monitor on this machine; a colleague's copy is reviewed on theirs.
 * - **`monitor_status`** reads: every monitor's state, or one monitor's alerts and rows.
 * - **`monitor_show`** runs a check now or puts a monitor's grid or the dashboard on screen.
 * - **`monitor_control`** changes what the user is told - pause, snooze, acknowledge, notification level.
 *   Always asked: an agent able to silence an alert unseen would defeat the dashboard.
 *
 * The engine is the judge every time: rows, levels and alerts come back from Fire Code's Rust code, never
 * from this side guessing (`MonitoringChannel`).
 */

/**
 * What a tool should return to be monitored well - said to the agent where it plans a monitor, because a
 * tool written for a person (a sentence, a formatted table) reads as one row per line and rules cannot
 * compare its numbers. Asked for: "agent should be able to create tools in the way it can return data in a
 * format supported for monitoring".
 */
export const MONITOR_TOOL_FORMAT =
  'FORMAT a monitor reads: make the Python tool\'s run() return a LIST OF DICTS - one dict per thing watched (a job, a host, ' +
  'a feed), the same keys in each; flat values (str, int, float, bool or None - a nested dict is read with a dotted key ' +
  'such as "owner.name"); numbers as numbers, never "1,250" or "84 min" strings; timestamps as ISO 8601 ' +
  '("2026-10-25T14:05:00Z") or epoch seconds, so olderThan/newerThan rules work; one key that names the row (job, host) ' +
  'for the monitor\'s "key"; a status as a short fixed word (FAILURE, OK) rules can match. Return [] when there is nothing ' +
  'to report - never a message saying so. RAISE an exception when the data cannot be read, so the tile turns purple ' +
  '(cannot tell) instead of green. Keep it fast (seconds) and read-only. {"rows": [...]} and {"columns": [...], "rows": ' +
  '[[...]]} are read too. Try it with monitor_create tryOnly: true before saving. FOR SPEED: when Polars is installed in ' +
  'the tools\' environment (monitor_check_tool says), use it rather than pandas - read, filter and aggregate in Polars ' +
  '(lazy scans for big files) and return df.to_dicts(); return only the rows and fields the rules need. light_code.call_tool ' +
  'takes keyword arguments: call_tool("name", job="X"), never a dict.'

export interface MonitorToolOptions {
  channel: MonitoringChannel
  /** `write_skill` as the bridge built it: the same folders, publishing and approval as any skill. */
  writeSkill: Tool<{ name: string; description: string; body: string; audience?: 'me' | 'team' | undefined }>
  /** Runs a monitor's tool here, once, by the rule monitors run tools by (`monitorToolRefusal`). */
  runTool: (name: string, args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>
  /** Whether the Python tools' environment has a module, without importing it; undefined when it cannot tell. */
  hasModule?: ((module: string) => Promise<boolean | undefined>) | undefined
}

const condition: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(condition) }),
    z.object({ any: z.array(condition) }),
    z.object({ not: condition }),
    z.object({ column: z.string(), op: z.string().optional(), value: z.unknown().optional() }),
  ]),
)

const level = z.enum(['red', 'amber', 'purple', 'blue', 'green', 'grey'])

const sourceSchema = z
  .union([
    z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
    z.object({ sqlite: z.string(), sql: z.string() }),
    z.object({ files: z.union([z.string(), z.array(z.union([z.string(), z.object({ name: z.string().optional(), path: z.string() })]))]), sql: z.string() }),
  ])
  .describe(
    'Where the rows come from - PREFER, IN THIS ORDER: (1) {"sqlite": ...} or {"files": ...} when the data is a database or a file - Fire Code ' +
      'reads it itself; (2) one of Fire Code\'s Rust tools with "records": true in its args, for files, folders, logs and tables - Rust ' +
      'collects and judges, no Python: find_files (a feed file late or missing: ageMinutes, sizeBytes), grep_files (ERROR lines across ' +
      'logs or shares: path, line, text), big_file action "search" (one huge log: line, text), query_table (a CSV or Excel sheet, ' +
      'filtered and grouped), query_sqlite (action "query"), dataframe (SQL across several files) - e.g. {"tool": "find_files", "args": ' +
      '{"roots": ["//fileserver/feeds"], "names": ["prices_*.csv"], "records": true}}; (3) an existing Python or MCP tool that already returns ' +
      'records; (4) only then a new Python tool - for an API or logic the others cannot do, calling the Rust tools for the heavy lifting. ' +
      '{"tool": "py__name", "args": {...}}: a Python tool (returning a list of records), an MCP tool or a read tool - ' +
      'runs in the background with the settings Fire Code monitoring uses. {"sqlite": "C:\\\\full\\\\path.db", "sql": "select ..."}: read by Fire Code ' +
      'itself, never locked. {"files": ["C:\\\\full\\\\path.csv"], "sql": "select ... from data"}: CSV, TSV, Excel or JSON, queried with SQL (the first ' +
      'file is the table "data", the second "data2").',
  )

const createSchema = z.object({
  name: z.string().describe('kebab-case, e.g. "overnight-batch" - the monitor and its skill file.'),
  title: z.string().describe('What the tile says, a few words: "Overnight batch".'),
  summary: z.string().describe('One sentence shown on hover: what it watches and what an alert means.'),
  audience: z
    .enum(['me', 'team'])
    .optional()
    .describe('"me": a Personal monitor, only on this computer - always possible. "team": shown under Team alerts and shared where the team shares skills; needs the team\'s OpenSearch history (Settings → Monitoring). Left out: team when that history is set up, otherwise personal. Use "me" whenever the user says personal, private, just for me or similar - and a request worded that way is made personal whatever is passed.'),
  every: z
    .union([z.string(), z.number()])
    .optional()
    .describe('How often to check: "5m", "15m", "1h", "1d" (one minute at least). Leave out when "at" gives the times instead; both together check at the times and in between.'),
  at: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Exact times of day: "07:30" for once a day, or ["07:30", "12:00", "18:00"]. Run on the "days" given, whatever activeHours says.'),
  activeHours: z
    .string()
    .optional()
    .describe('A run window for "every": "07:00-19:00" (past midnight is allowed), "09:00-" for not before nine, "-17:00" for until five.'),
  days: z.array(z.string()).optional().describe('Only on these days, e.g. ["mon","tue","wed","thu","fri"]; for both "every" and "at".'),
  source: sourceSchema,
  rows: z.string().optional().describe('Where the list of rows is in the answer, as a dotted path ("data.jobs"), when it is not found by itself.'),
  columns: z
    .array(z.object({ key: z.string(), label: z.string().optional(), format: z.enum(['text', 'number', 'percent', 'datetime', 'duration', 'bytes']).optional(), width: z.number().optional() }))
    .optional()
    .describe('The grid columns, in order. Omit to show every field. A dotted key reads inside a nested object.'),
  key: z.string().optional().describe('The column that identifies a row (a job name, a host) - acknowledgements stay with that row across checks.'),
  rules: z
    .array(
      z.object({
        level,
        when: condition.describe(
          '{"column", "op", "value"} with op ==, !=, >, >=, <, <=, contains, notContains, startsWith, endsWith, matches (regex), in, notIn (value a list), ' +
            'empty, notEmpty, olderThan / newerThan (value "30m", "2h", for a timestamp column); or {"all": [...]}, {"any": [...]}, {"not": {...}}.',
        ),
        highlight: z.enum(['row', 'cell']).optional().describe('Colour the whole row, or just the cell (the default when the rule is about one column).'),
        column: z.string().optional().describe('Which cell to colour, when not the rule\'s own column.'),
        message: z.string().optional().describe('The alert text, filled from the row: "{name} failed at {lastEnd}".'),
        advice: z
          .string()
          .optional()
          .describe("The author's own words for this alert: what it means and what to do (who to call, what to rerun, what to check). Shown and used when the alert is explained."),
      }),
    )
    .describe('Alert rules, tried on every row. red = failure / needs attention, amber = warning, blue = information, purple = no data or cannot tell.'),
  whenEmpty: level.optional().describe('The level when there are no rows. Default green.'),
  whenClear: level.optional().describe('The level when there are rows and no rule fires. Default green.'),
  notify: level.optional().describe('The least severe level that sends a Windows notification for this monitor. Default amber. How each level notifies is the user\'s setting.'),
  details: sourceSchema
    .optional()
    .describe('The breakdown shown when the user double-clicks a row: a source whose args or SQL take {column} values from that row, e.g. {"tool": "py__job_runs", "args": {"job": "{name}"}}. Omit to show the row\'s own fields.'),
  timeoutSeconds: z.number().int().min(5).max(900).optional().describe('How long one check may take. Default 120.'),
  runbook: z
    .string()
    .optional()
    .describe('The author\'s general advice for this monitor: who owns it, where to look first, known false alarms. Used with each rule\'s advice when an alert is explained.'),
  notes: z.string().optional().describe('Markdown for the skill body: what this watches, why, and what to do about each alert.'),
  tryOnly: z
    .boolean()
    .optional()
    .describe('Run the source once and show what Fire Code makes of it - columns, rows, alerts - without saving anything. Use it while writing or fixing the tool.'),
})
type CreateParams = z.infer<typeof createSchema>

/** The ` ```monitor ` block: the spec alone, in the order a person reads it. */
export function monitorBlock(params: CreateParams): string {
  const spec: Record<string, unknown> = { title: params.title, summary: params.summary, ...(params.every !== undefined ? { every: params.every } : {}) }
  for (const key of ['at', 'activeHours', 'days', 'source', 'rows', 'columns', 'key', 'rules', 'whenEmpty', 'whenClear', 'notify', 'details', 'timeoutSeconds', 'runbook'] as const) {
    if (params[key] !== undefined) spec[key] = params[key]
  }
  return JSON.stringify(spec, null, 2)
}

export function monitorSkillBody(params: CreateParams, block: string): string {
  return [
    `# ${params.title}`,
    '',
    params.summary,
    '',
    ...(params.notes !== undefined && params.notes.trim().length > 0 ? [params.notes.trim(), ''] : []),
    `This skill is a **Fire Code monitor**: Fire Code checks it ${params.every !== undefined ? `every ${String(params.every)}` : ''}${params.every !== undefined && params.at !== undefined ? ' and ' : ''}${params.at !== undefined ? `at ${[params.at].flat().join(', ')}` : ''} and shows it on the Monitoring dashboard. ` +
      'The block below is its definition. Change it with monitor_create under the same name, so the change is approved again; ' +
      'an edit by hand is reviewed on the dashboard before it runs.',
    '',
    '```monitor',
    block,
    '```',
    '',
  ].join('\n')
}

interface Evaluated {
  level: string
  meaning: string
  headline: string
  rows: number
  columns: { key: string }[]
  alerts: { level: string; message: string }[]
  sourceKind: string
}

function describeEvaluation(e: Evaluated): string {
  const keys = e.columns.map((c) => c.key)
  // Prose or plain values: read, but not as records a rule can compare.
  const shapeless = keys.length === 1 && (keys[0] === 'line' || keys[0] === 'value')
  return [
    `${e.level.toUpperCase()} (${e.meaning}) - ${e.headline}`,
    `${String(e.rows)} row(s); columns: ${keys.join(', ') || 'none'}`,
    ...e.alerts.slice(0, 10).map((a) => `- ${a.level}: ${a.message}`),
    ...(e.alerts.length > 10 ? [`- … ${String(e.alerts.length - 10)} more`] : []),
    ...(shapeless ? ['', `The answer is not records: it was read as one "${keys[0] ?? ''}" per row, so rules cannot compare fields. Change the tool. ${MONITOR_TOOL_FORMAT}`] : []),
  ].join('\n')
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Whether the user's own message asks for a personal or a team monitor - "personal", "just for me", "private",
 * "only on my machine"; or "team", "shared", "for everyone". Both or neither: undefined (the agent's choice and
 * the default stand). Words only: what the user typed, never anything a tool returned.
 */
export function askedAudience(text: string): 'me' | 'team' | undefined {
  const personal = /\b(personal|private|privately|just (for )?me|only (for )?me|for myself|my own|only on (this|my) (computer|machine|pc|laptop))\b/i.test(text)
  const team = /\b(team|shared|for everyone|for the team|colleagues)\b/i.test(text.replace(/\bteam (history|index|opensearch)\b/gi, ''))
  if (personal && !team) return 'me'
  if (team && !personal) return 'team'
  return undefined
}

export function createMonitorCreateTool(options: MonitorToolOptions): Tool<CreateParams> {
  const skillParams = (params: CreateParams, block: string, audience: 'me' | 'team') => ({
    name: params.name,
    description: `Monitor: ${params.summary.replace(/\s+/g, ' ').trim()}`,
    body: monitorSkillBody(params, block),
    audience,
  })
  /**
   * Who the monitor is for. Said: as said. Not said: the team when its history is set up, otherwise
   * personal - a personal monitor needs nothing configured, and refusing over a setting the user never
   * asked about was reported as "the agent cannot create personal checks".
   */
  const audienceFor = async (params: CreateParams, context?: ToolExecutionContext): Promise<{ audience: 'me' | 'team'; note?: string }> => {
    // The user's own words win (reported: asked for a personal check, got a team one - the agent left
    // audience out, and out means team once team history exists).
    const asked = askedAudience(context?.lastUserText?.() ?? '')
    if (asked === 'me' && params.audience !== 'me') return { audience: 'me', note: 'Personal (only on this computer), as you asked.' }
    if (params.audience !== undefined) return { audience: params.audience }
    if (asked === 'team') return { audience: 'team' }
    try {
      const listed = (await options.channel.request('list')) as { teamReady?: boolean }
      if (listed.teamReady === true) return { audience: 'team' }
    } catch {
      // Not knowing is no reason to refuse: personal works either way.
    }
    return {
      audience: 'me',
      note: "Personal (only on this computer): team monitors need the team's OpenSearch history, which is not set up in Fire Code → Settings → Monitoring.",
    }
  }
  /** What the engine makes of the block, and of rows a SQLite or file source gives now. */
  const tryIt = async (block: string, team = false): Promise<{ ok: true; note: string; native: boolean } | { ok: false; error: string }> => {
    try {
      if (team) {
        const listed = (await options.channel.request('list')) as { teamReady?: boolean; teamProblem?: string | null }
        if (listed.teamReady !== true) {
          return { ok: false, error: `A team monitor keeps its history in the team's OpenSearch index, and that is not set up: ${listed.teamProblem ?? 'Fire Code → Settings → Monitoring → Team history'}. Make it personal (audience "me"), or ask the user to set it up.` }
        }
      }
      const checked = (await options.channel.request('evaluate', { block })) as Evaluated
      if (checked.sourceKind === 'tool') {
        return { ok: true, native: false, note: 'After it is saved, its tool is run once here to show what the first check finds.' }
      }
      const answer = await options.channel.request('fetchPreview', { block })
      const tried = (await options.channel.request('evaluate', { block, rows: answer })) as Evaluated
      return { ok: true, native: true, note: `Tried now:\n${describeEvaluation(tried)}` }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }
  return {
    name: 'monitor_create',
    group: 'edit',
    description:
      'Create or replace a Fire Code monitor: a check that runs on a schedule and shows on the Monitoring dashboard as a coloured tile, ' +
      'with a data grid whose cells or rows are coloured by alert rules, and Windows notifications at the levels the user chose. ' +
      'Before creating one: find an existing tool that returns the data (search_docs, or the tools you have) and reuse it; if none ' +
      'does, write a Python tool with create_python_tool from the template in monitor_check_tool, and run monitor_check_tool until ' +
      'it says PASS - then use the columns and key it gives. A SQLite database or CSV/Excel file needs no tool. Rules are judged by Fire Code itself on every ' +
      'check - no model is involved - so make them exact. ASK THE AUTHOR (ask_user_form, one field per rule plus a general one) what each ' +
      'alert means and what to do about it, unless they already said, and put it in each rule\'s "advice" and in "runbook": that is what ' +
      'an agent tells whoever meets the alert later. A team monitor needs the team\'s OpenSearch history set in Fire Code → Settings → ' +
      'Monitoring; without it the monitor is created personal (only on this computer), which always works - say so to the user. The user approves the skill file; the result shows what the first check found. ' +
      MONITOR_TOOL_FORMAT,
    parametersSchema: createSchema,

    async preview(params, context): Promise<ToolPreview> {
      const block = monitorBlock(params)
      if (params.tryOnly === true) {
        return {
          kind: 'text',
          text: `Try the monitor "${params.name}" once - nothing is saved:\n\n${'tool' in params.source ? `Run ${params.source.tool}(${JSON.stringify(params.source.args ?? {})})` : `Read ${JSON.stringify(params.source)}`}`,
        }
      }
      const { audience, note: forWhom } = await audienceFor(params, context)
      const tried = await tryIt(block, audience === 'team')
      if (!tried.ok) {
        return { kind: 'text', text: `This monitor cannot be created as written - nothing will be saved:\n\n${tried.error}` }
      }
      const written = options.writeSkill.preview !== undefined ? await options.writeSkill.preview(skillParams(params, block, audience), context) : undefined
      if (written?.kind === 'diff') {
        return { ...written, note: [forWhom, written.note, tried.note, 'Approving this also lets it run on this computer.'].filter((n) => n !== undefined && n.length > 0).join('\n\n') }
      }
      return { kind: 'text', text: [forWhom, monitorSkillBody(params, block), tried.note].filter((n) => n !== undefined).join('\n\n') }
    },

    async execute(params, context): Promise<ToolResult> {
      const block = monitorBlock(params)
      const { audience, note: forWhom } = params.tryOnly === true ? { audience: 'me' as const, note: undefined } : await audienceFor(params, context)
      const tried = await tryIt(block, audience === 'team')
      if (!tried.ok) return { content: `Not created: ${tried.error}`, isError: true }
      if (params.tryOnly === true) {
        if (tried.native || !('tool' in params.source)) return { content: `Nothing saved.\n\n${tried.note}` }
        const result = await options.runTool(params.source.tool, params.source.args ?? {}, context)
        if (result.isError === true) return { content: `Nothing saved. The tool failed:\n${result.content.slice(0, 3000)}`, isError: true }
        try {
          const e = (await options.channel.request('evaluate', { block, text: result.content })) as Evaluated
          return { content: `Nothing saved. Fire Code reads this answer as:\n${describeEvaluation(e)}\n\nThe tool's answer, checked:\n${describeRowsCheck(checkMonitorRows(result.content))}` }
        } catch (error) {
          return { content: `Nothing saved. The answer could not be read as rows: ${message(error)}\n\n${MONITOR_TOOL_FORMAT}`, isError: true }
        }
      }
      const written = await options.writeSkill.execute(skillParams(params, block, audience), context)
      if (written.isError === true) return written
      const lines = [written.content, ...(forWhom !== undefined ? [forWhom] : [])]
      try {
        await options.channel.request('approve', { name: params.name, block })
      } catch (error) {
        lines.push(`It is saved, but monitoring could not approve it here: ${message(error)} Approve it on the dashboard.`)
        return { content: lines.join('\n\n') }
      }
      if (!tried.native && 'tool' in params.source) {
        const result = await options.runTool(params.source.tool, params.source.args ?? {}, context)
        if (result.isError === true) {
          lines.push(`The first try of ${params.source.tool} failed, so the tile will show purple until it works:\n${result.content.slice(0, 2000)}`)
        } else {
          try {
            const e = (await options.channel.request('evaluate', { block, text: result.content })) as Evaluated
            lines.push(`First check:\n${describeEvaluation(e)}`)
          } catch (error) {
            lines.push(`The tool answered, but its answer could not be read as rows: ${message(error)}`)
          }
        }
      } else {
        lines.push(tried.note)
      }
      await options.channel.request('run', { name: params.name }).catch(() => undefined)
      lines.push('It is approved on this computer and its first check has started; it shows on the Monitoring dashboard. If the rows or rules are not right, call monitor_create again with the same name.')
      return { content: lines.join('\n\n') }
    },
  }
}

const checkToolSchema = z.object({
  tool: z.string().describe('The tool to check, e.g. "py__pay_job_status".'),
  args: z.record(z.string(), z.unknown()).optional().describe('The arguments the monitor will call it with.'),
})

/**
 * Runs a tool once and checks its answer strictly against what a monitor needs (`rowsCheck.ts`), so the
 * agent can make a monitoring tool work before a monitor depends on it. It runs code, so it is a command
 * like calling the tool itself, under the same rule monitors run tools by.
 */
export function createMonitorCheckToolTool(options: MonitorToolOptions): Tool<z.infer<typeof checkToolSchema>> {
  return {
    name: 'monitor_check_tool',
    group: 'command',
    description:
      'Run a tool once and check its answer is what a Fire Code monitor needs: a list of records with one type per field, numbers ' +
      'as numbers, ISO timestamps, a field naming each row, failures raised rather than returned. Says PASS or FAIL with what to ' +
      'change, the fields it found, and the "columns" and "key" to give monitor_create. FIRST consider no new tool at all: a SQLite or ' +
      'file source, or a Rust tool with "records": true (find_files, grep_files, big_file search, query_table, query_sqlite, dataframe) - ' +
      'check those with this tool too. HOW TO MAKE A MONITORING TOOL when one is needed: (1) reuse a ' +
      'tool that already returns the data if one passes this check - it must only read, since a monitor runs it unattended; (2) otherwise write a Python tool with create_python_tool ' +
      '(audience "team" for a team monitor, "me" for a personal one) starting from this template, reading the real source - use ' +
      'light_code.credential("name") for a saved credential, never a password in the code:\n' +
      MONITOR_TOOL_TEMPLATE +
      '\n(3) call monitor_check_tool and fix the tool until it says PASS; (4) only then call monitor_create with the "columns" and "key" it suggests.',
    parametersSchema: checkToolSchema,

    async preview(params): Promise<ToolPreview> {
      return { kind: 'text', text: `Run ${params.tool}(${JSON.stringify(params.args ?? {}, null, 2)}) once and check what it returns.` }
    },

    async execute(params, context): Promise<ToolResult> {
      const result = await options.runTool(params.tool, params.args ?? {}, context)
      if (result.isError === true) {
        return {
          content: `FAIL - the tool raised:\n${result.content.slice(0, 3000)}\n\nThat is what a monitor shows as purple (cannot tell). Fix the tool and check again.`,
          isError: true,
        }
      }
      return { content: `${describeRowsCheck(checkMonitorRows(result.content))}\n\n${await polarsNote(options)}` }
    },
  }
}

/** Polars or not, in words for the agent writing the tool (asked for: prefer Polars when it is installed). */
async function polarsNote(options: MonitorToolOptions): Promise<string> {
  const has = await options.hasModule?.('polars').catch(() => undefined)
  if (has === true) return 'Polars is installed in the tools\' environment: use it rather than pandas for reading, filtering and aggregating (return df.to_dicts()).'
  if (has === false) return 'Polars is not installed in the tools\' environment: plain Python (or pandas, if installed) it is. If the data is big, ask the user whether to install polars (install_python_packages).'
  return 'Could not tell whether Polars is installed; if `import polars` works, prefer it to pandas.'
}

const statusSchema = z.object({
  name: z.string().optional().describe('One monitor, for its alerts and rows. Omit for every monitor.'),
  rows: z.number().int().min(0).max(1000).optional().describe('How many rows of one monitor to include. Default 50.'),
  onlyAlerts: z.boolean().optional().describe('Only the rows with an alert.'),
})

interface MonitorView {
  name: string
  title: string
  level: string
  status: string
  headline: string
  team: boolean
  origin: string
  lastRun?: number | null
  paused: boolean
  snoozeUntil?: number | null
  approved: boolean
  openAlerts?: number | null
}

function when(seconds: number | null | undefined): string {
  if (seconds === undefined || seconds === null) return 'never'
  return new Date(seconds * 1000).toLocaleString()
}

export function createMonitorStatusTool(options: MonitorToolOptions): Tool<z.infer<typeof statusSchema>> {
  return {
    name: 'monitor_status',
    group: 'read',
    description:
      "What Fire Code's monitors show now: every monitor's colour, headline and state, or - with name - one monitor's alerts and rows " +
      '(as JSON records, which dataframe can take further) and its recent history. Use it before answering a question about an alert.',
    parametersSchema: statusSchema,
    async execute(params): Promise<ToolResult> {
      try {
        if (params.name === undefined) {
          const list = (await options.channel.request('list')) as { monitors: MonitorView[]; enabled: boolean }
          if (list.monitors.length === 0) return { content: 'No monitors yet. monitor_create makes one.' }
          return {
            content: list.monitors
              .map(
                (m) =>
                  `- ${m.name} (${m.team ? 'Team' : 'Personal'}, ${m.origin}): ${m.level.toUpperCase()} - ${m.headline}` +
                  ` · last check ${when(m.lastRun)}` +
                  (m.paused ? ' · PAUSED' : '') +
                  (m.snoozeUntil ? ` · snoozed until ${when(m.snoozeUntil)}` : '') +
                  (!m.approved ? ' · NOT APPROVED on this computer' : ''),
              )
              .join('\n'),
          }
        }
        const got = (await options.channel.request('get', { name: params.name, rows: params.rows ?? 50, ...(params.onlyAlerts === true ? { onlyAlerts: true } : {}) })) as {
          monitor: MonitorView & { summary: string; error?: string | null }
          record?: { evaluation?: { alerts: { id: string; level: string; message: string; acknowledged: boolean }[]; rows: unknown[]; rowsTotal?: number } } | null
          history?: { at: number; level: string }[]
        }
        const m = got.monitor
        const e = got.record?.evaluation
        const changes = (got.history ?? []).filter((p, i, all) => i === 0 || all[i - 1]?.level !== p.level).slice(-10)
        return {
          content: [
            `${m.title} (${m.name}): ${m.level.toUpperCase()} - ${m.headline}`,
            m.summary,
            `Last check ${when(m.lastRun)}${m.error ? ` - failed: ${m.error}` : ''}`,
            '',
            'Alerts:',
            ...(e?.alerts.length ? e.alerts.map((a) => `- [${a.id}] ${a.level}${a.acknowledged ? ' (acknowledged)' : ''}: ${a.message}`) : ['- none']),
            '',
            `Rows (${String(e?.rows.length ?? 0)} of ${String(e?.rowsTotal ?? e?.rows.length ?? 0)}):`,
            JSON.stringify(e?.rows ?? []),
            '',
            `Level changes: ${changes.map((p) => `${when(p.at)} ${p.level}`).join(' → ') || 'none recorded'}`,
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const historySchema = z.object({
  name: z.string().describe('The monitor.'),
  key: z.string().optional().describe('One row: its key value (a job name, a host) - its alerts\' history only.'),
  alert: z.string().optional().describe('One alert, by the id monitor_status shows.'),
  days: z.number().int().min(1).max(366).optional().describe('How far back. Default 14.'),
})

interface AlertPattern {
  id: string
  key: string
  level: string
  message: string
  verdict: string
  summary: string
  firstSeen: number
  lastSeen: number
  occurrences: number
  checks: number
  days: { date: string; count: number }[]
}

/**
 * An alert's history - "agent should be able to check the history of alert to see if it is a repeating one or
 * a new issue or happens for past few days". Fire Code works it out from the stored checks (the same
 * function the grid's explanation uses, `monitor.rs` alert_history), so the agent and the dashboard agree.
 */
export function createMonitorHistoryTool(options: MonitorToolOptions): Tool<z.infer<typeof historySchema>> {
  return {
    name: 'monitor_history',
    group: 'read',
    description:
      "A monitor's past checks and, for each alert, whether it is new, ongoing (since when, how many checks in a row), recurring " +
      '(on how many days, usually at what time) or intermittent - worked out by Fire Code from the stored checks (the team\'s, for a ' +
      'team monitor). Use it before saying whether an alert is new or known, and when investigating one.',
    parametersSchema: historySchema,
    async execute(params): Promise<ToolResult> {
      try {
        const got = (await options.channel.request('history', {
          name: params.name,
          days: params.days ?? 14,
          ...(params.key !== undefined ? { key: params.key } : {}),
          ...(params.alert !== undefined ? { alert: params.alert } : {}),
        })) as { checks: { at: number; level: string; headline: string; by?: string; alerts: number }[]; patterns: AlertPattern[]; days: number }
        const changes = got.checks.filter((c, i, all) => i === all.length - 1 || all[i + 1]?.level !== c.level)
        return {
          content: [
            `${params.name}: ${String(got.checks.length)} check(s) in the last ${String(got.days)} day(s).`,
            '',
            'Alerts:',
            ...(got.patterns.length === 0
              ? ['- none in this period']
              : got.patterns.map(
                  (p) =>
                    `- [${p.id}] ${p.level} ${p.key}: ${p.verdict.toUpperCase()} - ${p.summary}` +
                    (p.days.length > 0 ? ` (by day: ${p.days.map((d) => `${d.date} ${String(d.count)}`).join(', ')})` : ''),
                )),
            '',
            'Level changes, newest first:',
            ...changes.slice(0, 30).map((c) => `- ${when(c.at)} ${c.level}${c.by ? ` (checked by ${c.by})` : ''} - ${c.headline}`),
          ].join('\n'),
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const showSchema = z.object({
  action: z.enum(['run', 'open', 'dashboard']).describe('run: check now. open: the monitor\'s grid window. dashboard: the Monitoring dashboard.'),
  name: z.string().optional().describe('The monitor, for run and open.'),
})

export function createMonitorShowTool(options: MonitorToolOptions): Tool<z.infer<typeof showSchema>> {
  return {
    name: 'monitor_show',
    group: 'read',
    description: 'Check a monitor now, or put its grid window or the Monitoring dashboard on the user\'s screen.',
    parametersSchema: showSchema,
    async execute(params): Promise<ToolResult> {
      try {
        if (params.action !== 'dashboard' && params.name === undefined) return { content: `Name the monitor to ${params.action}.`, isError: true }
        await options.channel.request(params.action, params.name !== undefined ? { name: params.name } : {})
        return {
          content:
            params.action === 'run'
              ? `Checking ${params.name ?? ''} now; monitor_status shows the result in a moment.`
              : params.action === 'open'
                ? `${params.name ?? ''}'s grid is on screen.`
                : 'The Monitoring dashboard is on screen.',
        }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}

const controlSchema = z.object({
  action: z.enum(['pause', 'resume', 'snooze', 'ack', 'unack', 'notify']),
  name: z.string(),
  minutes: z.number().int().min(0).max(10_080).optional().describe('snooze: how long (0 ends a snooze). ack: how long the acknowledgement lasts; omit for as long as the alert lasts.'),
  ids: z.array(z.string()).optional().describe('ack / unack: which alerts, by the ids monitor_status shows. Omit for every alert.'),
  note: z.string().optional().describe('ack: why, kept with it.'),
  mode: z.enum(['default', 'off', 'dashboard', 'silent', 'toast', 'urgent', 'alarm']).optional().describe('notify: how this monitor tells the user, replacing the per-level setting; "default" goes back to it.'),
  notifyFrom: z.enum(['default', 'red', 'amber', 'purple', 'blue', 'green']).optional().describe('notify: the least severe level that notifies.'),
})

export function createMonitorControlTool(options: MonitorToolOptions): Tool<z.infer<typeof controlSchema>> {
  return {
    name: 'monitor_control',
    group: 'edit',
    description:
      'Change what a monitor tells the user: pause or resume its checks, snooze its notifications, acknowledge (or un-acknowledge) alerts so ' +
      'they stop counting until they get worse, or change how it notifies. Always asks the user - use it when they asked.',
    parametersSchema: controlSchema,

    async preview(params): Promise<ToolPreview> {
      const lines: string[] = []
      switch (params.action) {
        case 'pause':
          lines.push(`Pause "${params.name}": no checks and no notifications until it is resumed.`)
          break
        case 'resume':
          lines.push(`Resume "${params.name}".`)
          break
        case 'snooze':
          lines.push(params.minutes === 0 ? `End the snooze on "${params.name}".` : `Snooze "${params.name}" for ${String(params.minutes ?? 60)} minutes: it keeps checking, and tells nobody.`)
          break
        case 'notify':
          lines.push(`"${params.name}" notifies: ${params.mode ?? 'unchanged'}; from level: ${params.notifyFrom ?? 'unchanged'}.`)
          break
        default: {
          // The alerts themselves, read now, not the model's account of them (invariant 8).
          lines.push(`${params.action === 'ack' ? 'Acknowledge' : 'Un-acknowledge'} on "${params.name}"${params.minutes !== undefined ? ` for ${String(params.minutes)} minutes` : ''}:`)
          try {
            const got = (await options.channel.request('get', { name: params.name, rows: 0 })) as { record?: { evaluation?: { alerts: { id: string; level: string; message: string }[] } } | null }
            const alerts = (got.record?.evaluation?.alerts ?? []).filter((a) => params.ids === undefined || params.ids.includes(a.id))
            lines.push(...(alerts.length > 0 ? alerts.map((a) => `- ${a.level}: ${a.message}`) : ['- no matching alerts']))
          } catch (error) {
            lines.push(`(could not read its alerts: ${message(error)})`)
          }
          if (params.note !== undefined) lines.push('', `Note: ${params.note}`)
        }
      }
      return { kind: 'text', text: lines.join('\n') }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const { action, ...rest } = params
        const args = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
        const answer = await options.channel.request(action === 'resume' ? 'pause' : action, action === 'resume' ? { ...args, on: false } : args)
        return { content: `Done: ${JSON.stringify(answer)}` }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}
