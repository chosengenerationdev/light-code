import { z } from 'zod'

import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import {
  AUTOSYS_PATH_KEYS,
  AUTOSYS_SENDING_KEYS,
  autosysPathProblem,
  DEFAULT_AUTOSYS_PATHS,
  isAutosysName,
  type AutosysAddressCheck,
  type AutosysClient,
  type AutosysPaths,
} from './autosys.js'

/**
 * Finding the addresses an AutoSys server actually answers at, and keeping them.
 *
 * Reported from real use: Test connection said 404, one job's status worked, and `JOB*UK` did not -
 * the office's AutoSys REST service answers at addresses of its own (a `/v1` here, an `/AEWS` there),
 * which the defaults cannot know. Asked for: let the agent learn them from the internal wiki and set
 * them, and let the team share what it learned.
 *
 * Two tools, split by what they can do:
 *
 * - **`autosys_check_addresses`** (read) tries addresses - the saved ones, ones the agent read on a
 *   wiki page, and with `common` the usual layouts - with a job the user names, and says what came
 *   back, address by address, with each answer's field names. It changes nothing, so the agent can
 *   iterate: read the wiki, try what it says, try a variant.
 * - **`autosys_set_addresses`** (edit, always asks, never in a schedule) saves them. Its approval is
 *   the change itself - the addresses before and after - with each changed address tried live
 *   (invariant 8): what the user approves is what the server answered, not the model's account of a
 *   wiki page.
 *
 * **The wiki is read with the tools that already exist** (`confluence_search`, `confluence_read_page`,
 * or a page the user drops in), and a wiki page is only ever a *source of candidates*: nothing is kept
 * until the server has answered at it. A page can be out of date; the server cannot be.
 *
 * **Addresses never reach another host.** `autosysPathProblem` holds every template to a path on the
 * configured site - the credential goes with every request - and the client checks it again on use.
 * Addresses that are *sent to* (events, JIL) are never tried, since a test event is a real event.
 *
 * **Shared with the team through export**: the "AutoSys addresses" section (`config/share.ts`) carries
 * `autosys.paths` alone, so a colleague imports the addresses without touching their own sign-in or
 * their other DevOps sites.
 */

export interface AutosysAddressToolOptions {
  client: () => Promise<AutosysClient>
  /** The saved overrides (`autosys.paths`), absent ones meaning the default. */
  currentPaths: () => Promise<Partial<AutosysPaths>>
  /** Replaces the saved overrides. Absent: the save tool is not offered. */
  savePaths?: ((paths: Partial<AutosysPaths>) => Promise<void>) | undefined
  /** `autosys.testJob`: a job to try addresses with when the request names none. */
  testJob?: string | undefined
  defaultPattern?: string | undefined
}

/** Prefixes a server's REST service commonly sits under, tried with `common`. */
const COMMON_PREFIXES = ['', '/v1', '/AEWS', '/AEWS/v1', '/api/v1', '/wla/v1']

/** Pattern queries other than FIQL, tried with `common` for the two pattern addresses people use most. */
const PATTERN_QUERIES: Partial<Record<keyof AutosysPaths, readonly string[]>> = {
  jobs: ['/job?name={pattern}', '/job?jobName={pattern}'],
  runInfo: ['/job-run-info?name={pattern}', '/job-run-info?jobName={pattern}', '/job-status?filter={filter:name}'],
  jobRunInfo: ['/job-status/{job}', '/job/{job}/status'],
}

const DEFAULT_CHECKED: readonly (keyof AutosysPaths)[] = ['jobs', 'job', 'runInfo', 'jobRunInfo', 'runHistory', 'eventHistory']

const keySchema = z.enum(AUTOSYS_PATH_KEYS as [keyof AutosysPaths, ...(keyof AutosysPaths)[]])

const checkSchema = z.object({
  job: z.string().optional().describe('A job that exists - addresses are tried with it. Default the configured test job. Ask the user for one when there is none.'),
  pattern: z.string().optional().describe('A pattern for the pattern addresses (* wildcards). Default the job followed by *.'),
  machine: z.string().optional().describe('A machine name, to also try the machine addresses.'),
  calendar: z.string().optional().describe('A calendar name, to also try the calendar addresses.'),
  keys: z.array(keySchema).optional().describe('Which addresses to try. Default jobs, job, runInfo, jobRunInfo, runHistory, eventHistory.'),
  addresses: z
    .record(z.string(), z.string())
    .optional()
    .describe('Candidate templates to try before the saved ones - e.g. from the office wiki: {"runInfo": "/v1/job-run-info?filter={filter:name}"}.'),
  common: z.boolean().optional().describe('Also try the usual layouts (/v1, /AEWS, /AEWS/v1, /api/v1, other query forms). Default true when nothing saved works.'),
})

/** One check as a line the user and the model can both read. */
export function describeCheck(check: AutosysAddressCheck): string {
  if (check.ok) {
    const what = check.records === undefined ? '' : `, ${String(check.records)} record(s)`
    const fields = check.fields !== undefined && check.fields.length > 0 ? ` - fields: ${check.fields.join(', ')}` : ''
    return `answers${what}${fields}`
  }
  return `${check.status !== undefined ? String(check.status) : 'failed'}: ${(check.message ?? '').slice(0, 300)}`
}

function candidatesFor(key: keyof AutosysPaths, current: string, given: string | undefined, common: boolean): string[] {
  const list = [...(given !== undefined ? [given] : []), current]
  if (common) {
    const shapes = [DEFAULT_AUTOSYS_PATHS[key], ...(PATTERN_QUERIES[key] ?? [])]
    for (const prefix of COMMON_PREFIXES) for (const shape of shapes) list.push(`${prefix}${shape}`)
  }
  return [...new Set(list)]
}

interface KeyOutcome {
  key: keyof AutosysPaths
  tried: AutosysAddressCheck[]
  /** The address to keep: the first that answered with something, else the first that answered at all. */
  chosen?: AutosysAddressCheck | undefined
}

export function createAutosysCheckAddressesTool(options: AutosysAddressToolOptions): Tool<z.infer<typeof checkSchema>> {
  return {
    name: 'autosys_check_addresses',
    group: 'read',
    description:
      'Find the addresses this AutoSys server answers at. Use when an AutoSys tool or Test connection gets a 404, or a pattern ' +
      '(JOB*UK) fails while one job works: the office REST service often lives under its own prefix (/v1, /AEWS). Tries the ' +
      'saved addresses, any candidates in `addresses`, and with `common` the usual layouts, with a job that exists, and shows ' +
      "each answer's field names. Changes nothing. If the office wiki documents the AutoSys REST API, read it first " +
      '(confluence_search / confluence_read_page) and pass what it says as `addresses`; then save what works with ' +
      'autosys_set_addresses.',
    parametersSchema: checkSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const job = (params.job ?? options.testJob)?.trim()
        if (job !== undefined && !isAutosysName(job)) return { content: `"${job}" is not a job name.`, isError: true }
        const pattern = (params.pattern ?? (job !== undefined ? `${job}*` : options.defaultPattern))?.trim()
        if (pattern !== undefined && !isAutosysName(pattern, true)) return { content: `"${pattern}" is not a job pattern.`, isError: true }
        if (job === undefined) {
          return {
            content:
              'Name a job that exists (`job`) - an address can only be judged by asking it about something real, and some servers ' +
              'answer 404 when nothing matches. Ask the user for one, or set "Job to check in Test connection".',
            isError: true,
          }
        }
        const given: Partial<Record<keyof AutosysPaths, string>> = {}
        const refused: string[] = []
        for (const [key, template] of Object.entries(params.addresses ?? {})) {
          const problem = autosysPathProblem(key as keyof AutosysPaths, template)
          if (problem !== undefined) refused.push(`- ${key} "${template}": ${problem}`)
          else given[key as keyof AutosysPaths] = template
        }
        const keys = [
          ...new Set([
            ...(params.keys ?? DEFAULT_CHECKED),
            ...(Object.keys(given) as (keyof AutosysPaths)[]),
            ...(params.machine !== undefined ? (['machines', 'machine'] as const) : []),
            ...(params.calendar !== undefined ? (['calendar'] as const) : []),
          ]),
        ].filter((key) => !AUTOSYS_SENDING_KEYS.includes(key))
        const values: Record<string, string> = {
          job,
          jobName: job,
          pattern: pattern ?? `${job}*`,
          boxName: pattern ?? job,
          runNum: '',
          type: 'stderr',
          ...(params.machine !== undefined ? { machine: params.machine } : {}),
          ...(params.calendar !== undefined ? { calendar: params.calendar } : {}),
        }
        const client = await options.client()
        const current = client.addresses
        // An object rather than a let: the lanes set it, and a narrowed let would read as never set.
        const halt: { by?: AutosysAddressCheck } = {}
        const run = async (common: boolean, only: readonly (keyof AutosysPaths)[]): Promise<KeyOutcome[]> =>
          Promise.all(
            only.map(async (key): Promise<KeyOutcome> => {
              const outcome: KeyOutcome = { key, tried: [] }
              let fallback: AutosysAddressCheck | undefined
              for (const template of candidatesFor(key, current[key], given[key], common)) {
                if (halt.by !== undefined) break
                if (outcome.tried.some((check) => check.template === template)) continue
                const check = await client.withPaths({ [key]: template }).check(key, values)
                outcome.tried.push(check)
                if (check.signIn === true) {
                  halt.by = check
                  break
                }
                if (check.ok && (check.records ?? 0) > 0) {
                  outcome.chosen = check
                  break
                }
                if (check.ok && fallback === undefined) fallback = check
              }
              outcome.chosen ??= fallback
              return outcome
            }),
          )
        let outcomes = await run(params.common === true, keys)
        // Nothing saved answered: the usual layouts are worth trying unless the caller said not to.
        const missing = outcomes.filter((outcome) => outcome.chosen === undefined).map((outcome) => outcome.key)
        if (halt.by === undefined && params.common === undefined && missing.length > 0) {
          const again = await run(true, missing)
          outcomes = outcomes.map((outcome) => again.find((other) => other.key === outcome.key) ?? outcome)
        }
        if (halt.by !== undefined) {
          return {
            content:
              `Stopped: the server refused the sign-in (${describeCheck(halt.by)}). That is the credential, not the address - ` +
              'check it in Settings → DevOps → AutoSys before trying addresses; nothing more was sent.',
            isError: true,
          }
        }
        const lines = [`Tried on ${client.base} with job ${job} and pattern ${values['pattern'] ?? ''}:`, '']
        const proposal: Partial<Record<keyof AutosysPaths, string>> = {}
        for (const outcome of outcomes) {
          const chosen = outcome.chosen
          if (chosen !== undefined) {
            lines.push(`✓ ${outcome.key}: ${chosen.template} - ${describeCheck(chosen)}`)
            if (chosen.template !== current[outcome.key]) proposal[outcome.key] = chosen.template
            if (chosen.records === 0) lines.push(`  (answered but empty - right address with the wrong filter form, or ${job} has none)`)
          } else {
            lines.push(`✗ ${outcome.key}: nothing answered (${String(outcome.tried.length)} tried)`)
            for (const check of outcome.tried.slice(0, 3)) lines.push(`  - ${check.template} - ${describeCheck(check)}`)
          }
        }
        if (refused.length > 0) lines.push('', 'Not tried - these candidates are not usable addresses:', ...refused)
        lines.push(
          '',
          Object.keys(proposal).length > 0
            ? `To keep the working ones, call autosys_set_addresses with addresses ${JSON.stringify(proposal)}.`
            : 'Every address that answered is already the saved one.',
        )
        if (outcomes.some((outcome) => outcome.chosen === undefined)) {
          lines.push(
            'For the ones that did not answer, the office wiki is the place to look: search it for the AutoSys REST / AEWS API, ' +
              'and try what it names here with `addresses`. A 404 whose words say no job matched means the address is right.',
          )
        }
        return { content: lines.join('\n') }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

const setSchema = z.object({
  addresses: z
    .record(z.string(), z.string().nullable())
    .describe('Address templates to save, by name (jobs, job, runInfo, jobRunInfo, log, ...). null puts one back to the default.'),
  source: z.string().max(300).optional().describe('Where these came from - the wiki page title or link - shown to the user when approving.'),
  job: z.string().optional().describe('A job that exists, to try each changed address with in the approval. Default the configured test job.'),
  pattern: z.string().optional().describe('A pattern for trying the pattern addresses. Default the job followed by *.'),
})

function render(paths: Partial<AutosysPaths>): string {
  const ordered = Object.fromEntries(AUTOSYS_PATH_KEYS.filter((key) => paths[key] !== undefined).map((key) => [key, paths[key]]))
  return `${JSON.stringify(ordered, null, 2)}\n`
}

interface Plan {
  next: Partial<AutosysPaths>
  changed: (keyof AutosysPaths)[]
  problems: string[]
}

function plan(current: Partial<AutosysPaths>, addresses: Record<string, string | null>): Plan {
  const next: Partial<AutosysPaths> = { ...current }
  const changed: (keyof AutosysPaths)[] = []
  const problems: string[] = []
  for (const [raw, template] of Object.entries(addresses)) {
    const key = raw as keyof AutosysPaths
    if (!AUTOSYS_PATH_KEYS.includes(key)) {
      problems.push(`"${raw}" is not an AutoSys address name - one of ${AUTOSYS_PATH_KEYS.join(', ')}.`)
      continue
    }
    // Saving the default as an override is the same as no override; kept sparse.
    if (template === null || template.trim() === DEFAULT_AUTOSYS_PATHS[key]) {
      if (next[key] !== undefined) {
        delete next[key]
        changed.push(key)
      }
      continue
    }
    const problem = autosysPathProblem(key, template.trim())
    if (problem !== undefined) {
      problems.push(`${key} "${template}": ${problem}`)
      continue
    }
    if (next[key] !== template.trim()) {
      next[key] = template.trim()
      changed.push(key)
    }
  }
  return { next, changed, problems }
}

const SHARE_HINT =
  'To give the team the same addresses: Settings → Export, tick only "AutoSys addresses" (or light_code_export_config with ' +
  'sections ["autosysAddresses"]); colleagues import it with that section ticked, and nothing else of theirs changes.'

export function createAutosysSetAddressesTool(
  options: AutosysAddressToolOptions & { savePaths: (paths: Partial<AutosysPaths>) => Promise<void> },
): Tool<z.infer<typeof setSchema>> {
  return {
    name: 'autosys_set_addresses',
    group: 'edit',
    description:
      'Save the addresses this AutoSys server answers at, so every AutoSys tool and Test connection uses them - after ' +
      'autosys_check_addresses found them working, or from the office wiki. Paths on the configured site only, e.g. ' +
      '"/v1/job-run-info?filter={filter:name}"; placeholders {job}, {pattern}, {filter:<field>}, {runNum}, {type}, ' +
      '{machine}, {calendar}. null resets one. The user approves, seeing each changed address tried live.',
    parametersSchema: setSchema,

    async preview(params): Promise<ToolPreview> {
      const current = await options.currentPaths()
      const { next, changed, problems } = plan(current, params.addresses)
      const notes: string[] = []
      if (params.source !== undefined) notes.push(`Learned from: ${params.source}`)
      if (problems.length > 0) notes.push(`Will be refused: ${problems.join(' ')}`)
      const job = (params.job ?? options.testJob)?.trim()
      const tryable = changed.filter((key) => next[key] !== undefined && !AUTOSYS_SENDING_KEYS.includes(key))
      if (problems.length === 0 && tryable.length > 0) {
        if (job === undefined || !isAutosysName(job)) {
          notes.push('Not tried live: no job to try them with.')
        } else {
          const pattern = params.pattern !== undefined && isAutosysName(params.pattern, true) ? params.pattern : `${job}*`
          try {
            const client = (await options.client()).withPaths(next)
            const values = { job, jobName: job, pattern, boxName: pattern, runNum: '', type: 'stderr' }
            const checks = await Promise.all(tryable.map((key) => client.check(key, values)))
            notes.push(`Tried now with ${job}: ${checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.key} ${describeCheck(check)}`).join('; ')}`)
          } catch (error) {
            notes.push(`Could not try them: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      const sent = changed.filter((key) => AUTOSYS_SENDING_KEYS.includes(key) && next[key] !== undefined)
      if (sent.length > 0) notes.push(`Not tried: ${sent.join(', ')} - those are sent to, and trying would change production.`)
      return {
        kind: 'diff',
        path: 'AutoSys addresses (settings).json',
        before: render(current),
        after: render(next),
        ...(notes.length > 0 ? { note: notes.join('\n') } : {}),
      }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const { next, changed, problems } = plan(await options.currentPaths(), params.addresses)
        if (problems.length > 0) return { content: `Nothing saved: ${problems.join(' ')}`, isError: true }
        if (changed.length === 0) return { content: 'Those are already the saved addresses; nothing changed.' }
        await options.savePaths(next)
        return {
          content: [
            `Saved ${changed.join(', ')}. Every AutoSys tool uses them from the next call.`,
            ...changed.map((key) => `- ${key}: ${next[key] ?? `default (${DEFAULT_AUTOSYS_PATHS[key]})`}`),
            '',
            SHARE_HINT,
          ].join('\n'),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

/** The address tools, the save one only where saving is wired. */
export function createAutosysAddressTools(options: AutosysAddressToolOptions): Tool<never>[] {
  const { savePaths } = options
  return [
    createAutosysCheckAddressesTool(options),
    ...(savePaths !== undefined ? [createAutosysSetAddressesTool({ ...options, savePaths })] : []),
  ] as unknown as Tool<never>[]
}
