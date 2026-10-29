/**
 * Whether a tool's answer is what a monitor needs, checked strictly - so the agent can make a monitoring
 * tool *work* before a monitor depends on it (asked for: "give it clear instruction or tool to create
 * monitoring tools which can make sure that it will work").
 *
 * The engine (Fire Code's monitor.rs) is forgiving on purpose: a wrapper object, a table, even prose is read
 * somehow. That is right at run time and wrong while writing a tool, where "read somehow" hides the mistake
 * that later makes a rule never fire. So this is the strict reading: what passes here is read the same way
 * every time, and every problem says what to change.
 */

export interface ColumnReport {
  key: string
  /** number, text, timestamp, boolean, empty, mixed, nested */
  type: string
  example?: string | undefined
  /** In how many of the rows it is present and not empty. */
  present: number
}

export interface RowsCheck {
  verdict: 'pass' | 'warn' | 'fail'
  rows: number
  problems: string[]
  warnings: string[]
  columns: ColumnReport[]
  /** A column whose values name every row once - for the monitor's "key". */
  suggestedKey?: string | undefined
}

const NUMERIC_TEXT = /^\s*[-+(]?[\d,]+(\.\d+)?\)?\s*(%|ms|s|sec|min|mins|h|hrs|kb|mb|gb|tb)?\s*$/i
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const OTHER_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(\s+\d{1,2}:\d{2}(:\d{2})?)?$|^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/
const ERRORISH = /^(error|errors|message|exception|failure|reason)$/i

function typeOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'nested'
  const text = String(value)
  if (ISO.test(text.trim())) return 'timestamp'
  return 'text'
}

/** Checks a tool's text answer (a Python tool's JSON, with any printed output after it). */
export function checkMonitorRows(text: string): RowsCheck {
  const problems: string[] = []
  const warnings: string[] = []
  const body = text.split('\n\n--- stdout ---\n')[0]?.trim() ?? ''
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return {
      verdict: 'fail',
      rows: 0,
      problems: ['It returned text, not data. run() must RETURN a list of dicts (not print, not a formatted string) - Fire Code serialises it as JSON.'],
      warnings: [],
      columns: [],
    }
  }
  let list: unknown = value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const keys = Object.keys(object)
    if (keys.some((k) => ERRORISH.test(k)) && !keys.some((k) => Array.isArray(object[k]))) {
      return {
        verdict: 'fail',
        rows: 0,
        problems: [`It returned ${JSON.stringify(object).slice(0, 200)} - a failure reported as data reads as a row, and the tile would not turn purple. RAISE an exception when the data cannot be read.`],
        warnings: [],
        columns: [],
      }
    }
    const inner = ['rows', 'items', 'data', 'results', 'records'].find((k) => Array.isArray(object[k]))
    if (inner !== undefined) {
      warnings.push(`The rows are inside "${inner}". That is read, but returning the list itself is simpler and needs no "rows" setting.`)
      list = object[inner]
    } else {
      problems.push('It returned one object. Return a LIST of dicts - one per thing watched - even when there is only one.')
      list = [value]
    }
  }
  if (!Array.isArray(list)) {
    return { verdict: 'fail', rows: 0, problems: [`It returned a ${typeof value}. run() must return a list of dicts.`], warnings: [], columns: [] }
  }
  const rows = list
  if (rows.length === 0) {
    warnings.push('It returned no rows, so the shape cannot be checked. That is right when there is nothing to report - check again with arguments that return data.')
  }
  const notObjects = rows.filter((r) => r === null || typeof r !== 'object' || Array.isArray(r)).length
  if (notObjects > 0) {
    problems.push(`${String(notObjects)} of ${String(rows.length)} items are not dicts. Every item must be a dict of field -> value, e.g. {"job": "PAY_LOAD", "status": "FAILURE"}.`)
  }
  const records = rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r))
  if (records.length > 0 && records.every((r) => Object.keys(r).some((k) => ERRORISH.test(k)) && Object.keys(r).length <= 2)) {
    problems.push('Every row is an error message. RAISE an exception when the data cannot be read, so the tile turns purple instead of showing it as data.')
  }
  if (rows.length > 5000) problems.push(`${String(rows.length)} rows - a monitor keeps 5000. Filter at the source and return what is worth watching.`)

  const keys: string[] = []
  for (const r of records.slice(0, 200)) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
  const columns: ColumnReport[] = keys.map((key) => {
    const values = records.map((r) => r[key])
    const types = new Set(values.map(typeOf).filter((t) => t !== 'empty'))
    const type = types.size === 0 ? 'empty' : types.size === 1 ? ([...types][0] ?? 'empty') : 'mixed'
    const sample = values.find((v) => typeOf(v) !== 'empty')
    return {
      key,
      type,
      ...(sample !== undefined ? { example: typeof sample === 'object' ? JSON.stringify(sample).slice(0, 60) : String(sample).slice(0, 60) } : {}),
      present: values.filter((v) => typeOf(v) !== 'empty').length,
    }
  })
  for (const c of columns) {
    const values = records.map((r) => r[c.key]).filter((v) => typeOf(v) === 'text') as string[]
    const numeric = values.filter((v) => NUMERIC_TEXT.test(v))
    if (numeric.length > 0 && numeric.length === values.length) {
      warnings.push(`"${c.key}" holds numbers as text (${JSON.stringify(numeric[0])}). Return a number (int or float, no units or commas) so > and < rules compare numbers.`)
    }
    const dates = values.filter((v) => OTHER_DATE.test(v.trim()))
    if (dates.length > 0) {
      warnings.push(`"${c.key}" has dates like ${JSON.stringify(dates[0])}. Return ISO 8601 ("2026-10-25T14:05:00Z", with a zone) so olderThan/newerThan rules read them the same everywhere.`)
    }
    if (c.type === 'nested') warnings.push(`"${c.key}" holds nested data. It is read with a dotted key ("${c.key}.field"); flat fields are easier to show and filter.`)
    if (c.type === 'mixed') warnings.push(`"${c.key}" mixes types (${[...new Set(records.map((r) => typeOf(r[c.key])).filter((t) => t !== 'empty'))].join(', ')}). Give each field one type.`)
    if (c.present < records.length && records.length > 1) warnings.push(`"${c.key}" is missing from ${String(records.length - c.present)} of ${String(records.length)} rows. Give every row the same fields (None for no value).`)
  }
  const suggestedKey = columns.find((c) => c.type === 'text' && c.present === records.length && new Set(records.map((r) => String(r[c.key]))).size === records.length && records.length > 0)?.key
  if (records.length > 1 && suggestedKey === undefined) {
    warnings.push('No field names each row uniquely. Add one (a job name, a host) - acknowledgements stay with a row by it across checks.')
  }
  return { verdict: problems.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass', rows: rows.length, problems, warnings, columns, ...(suggestedKey !== undefined ? { suggestedKey } : {}) }
}

/** The report as the agent reads it, ending with what to paste into monitor_create. */
export function describeRowsCheck(check: RowsCheck): string {
  const verdict = check.verdict === 'pass' ? 'PASS - ready for a monitor.' : check.verdict === 'warn' ? 'PASS with warnings - it will work; fixing these makes rules more reliable.' : 'FAIL - fix the tool and check again before creating a monitor.'
  const columns = check.columns.map((c) => ({ key: c.key, ...(c.type === 'number' ? { format: 'number' } : c.type === 'timestamp' ? { format: 'datetime' } : {}) }))
  return [
    verdict,
    `${String(check.rows)} row(s).`,
    ...(check.problems.length > 0 ? ['', 'Problems:', ...check.problems.map((p) => `- ${p}`)] : []),
    ...(check.warnings.length > 0 ? ['', 'Warnings:', ...check.warnings.map((w) => `- ${w}`)] : []),
    ...(check.columns.length > 0
      ? ['', 'Fields:', ...check.columns.map((c) => `- ${c.key}: ${c.type}${c.example !== undefined ? ` (e.g. ${c.example})` : ''}${c.present < check.rows ? `, in ${String(c.present)} rows` : ''}`)]
      : []),
    ...(check.verdict !== 'fail' && check.columns.length > 0
      ? ['', `For monitor_create: "columns": ${JSON.stringify(columns)}${check.suggestedKey !== undefined ? `, "key": "${check.suggestedKey}"` : ''}`]
      : []),
  ].join('\n')
}

/**
 * How to write a Python tool for a monitor - the template the agent starts from. A tool is created with
 * create_python_tool, checked with monitor_check_tool, and only then named by monitor_create.
 */
export const MONITOR_TOOL_TEMPLATE = `
"""<What it reads>, for monitoring: one record per <job | host | feed>."""
import json
from datetime import datetime, timezone

import light_code

# Big or tabular data: use Polars when it is installed (monitor_check_tool says whether it is) - filter and
# aggregate there and return df.to_dicts(). Fall back to plain Python (or pandas) only when it is not:
#   import polars as pl
#   df = pl.read_csv(path).filter(pl.col("status") != "OK").select(["job", "status", "minutes"])
#   return df.to_dicts()

# Tools this one calls with light_code.call_tool - MCP tools, other Python tools, and Fire Code's
# reading tools (autosys_status, jira_search, ...). Reviewed with the tool; in a monitor they run unasked.
__tool_calls__ = ["server__query_jobs"]
# Saved credentials it reads with light_code.credential("name"), if any - never a password in the code.
__credentials__ = []


def run(pattern: str = "PAY_*") -> list[dict]:
    """<One line>.

    Args:
        pattern: <what narrows it>.
    """
    # Either read the source directly, or call an existing tool (its answer is text - json.loads it
    # when the tool answers JSON). Let it RAISE when the data cannot be read - the tile turns purple.
    # Arguments are keywords: call_tool("server__query_jobs", pattern=pattern) - never a dict.
    items = json.loads(light_code.call_tool("server__query_jobs", pattern=pattern))
    rows = []
    for item in items:
        rows.append({
            "job": item["name"],                 # names the row: the monitor's "key"
            "status": str(item["status"]).upper(), # a short fixed word rules can match
            "minutes": int(item["minutes"]),      # numbers as numbers - no units, no commas
            "lastStart": datetime.fromisoformat(item["start"]).astimezone(timezone.utc).isoformat(),  # ISO 8601, with a zone
            "machine": item.get("machine") or None,  # None, not "", when there is no value
        })
    return rows                               # [] when there is nothing to report - never a message
`.trim()
