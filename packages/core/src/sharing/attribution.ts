/**
 * Who wrote a skill or a Python tool, which project it belongs to, which revision it is and when
 * that revision was saved — kept in the file itself.
 *
 * ## Why in the file
 *
 * Several teams share one bucket and one cluster, so a skill or tool arriving from either has to
 * say where it came from. The file is the source of truth for everything else about a skill or a
 * tool (§13), it is what the bucket carries, and a sidecar would be a second store that drifts
 * from the first the moment somebody copies one without the other.
 *
 * - **Skills** carry `author:`, `project:`, `version:` and `updated:` in their frontmatter.
 * - **Python tools** carry `__author__`, `__project__`, `__version__` and `__updated__` as plain
 *   string assignments, the ordinary Python convention for module metadata, so they read as normal
 *   code in the source a user approves.
 *
 * ## Two kinds of field, two rules
 *
 * `author` and `project` are **filled, never replaced**. A skill copied in from a colleague already
 * names its author; overwriting that with whoever saved it next would be exactly the wrong
 * attribution `search_team_skills` exists to avoid.
 *
 * `version` and `updated` describe **this save**, so every write Light Code makes sets them:
 * the version goes up by one from the file it replaces, and `updated` is the time of the write, in
 * UTC so two people in different offices read the same moment the same way.
 *
 * ## Values are restricted
 *
 * Quotes, backslashes and line breaks are removed. In a Python file the value sits inside a string
 * literal, and in frontmatter a line break would end the block — either would turn a label into
 * something else.
 */

export interface Attribution {
  author?: string | undefined
  project?: string | undefined
  /** A whole number, 1 for the first save. */
  version?: number | undefined
  /** ISO 8601, UTC, to the second. */
  updated?: string | undefined
}

type Field = keyof Attribution
const FIELDS: readonly Field[] = ['author', 'project', 'version', 'updated']

/** What a value may contain once written. */
export function cleanAttributionValue(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const cleaned = String(value).replace(/["'\\\r\n]/g, '').trim().slice(0, 100)
  return cleaned.length > 0 ? cleaned : undefined
}

/** `2026-09-29T08:15:02Z`: sortable, unambiguous across time zones, and short. */
export function attributionTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`
}

function toAttribution(read: (field: Field) => string | undefined): Attribution {
  const version = Number.parseInt(read('version') ?? '', 10)
  return {
    author: read('author'),
    project: read('project'),
    version: Number.isFinite(version) && version > 0 ? version : undefined,
    updated: read('updated'),
  }
}

// -------------------------------------------------------------------------------------------------
// Skills

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

export function readSkillAttribution(source: string): Attribution {
  const block = FRONTMATTER.exec(source)?.[1]
  if (block === undefined) return {}
  return toAttribution((key) => {
    const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(block)
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '')
    return value !== undefined && value.length > 0 ? value : undefined
  })
}

/**
 * Sets fields in a skill's frontmatter: `replace` fields overwrite, the rest only fill a gap.
 * Unchanged when the file has no frontmatter — a skill without one is not loaded, and inventing a
 * block would change its name.
 */
function writeSkillFields(source: string, values: Attribution, replace: ReadonlySet<Field>): string {
  const match = FRONTMATTER.exec(source)
  if (match === null) return source
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const blockStart = source.indexOf(match[1] ?? '', match.index)
  let block = match[1] ?? ''
  const blockEnd = blockStart + block.length
  const existing = readSkillAttribution(source)

  for (const field of FIELDS) {
    const value = cleanAttributionValue(values[field])
    if (value === undefined) continue
    const line = new RegExp(`^${field}\\s*:.*$`, 'm')
    if (line.test(block)) {
      if (replace.has(field)) block = block.replace(line, `${field}: ${value}`)
    } else if (existing[field] === undefined) {
      block = `${block}${eol}${field}: ${value}`
    }
  }
  return `${source.slice(0, blockStart)}${block}${source.slice(blockEnd)}`
}

// -------------------------------------------------------------------------------------------------
// Python tools

/** Only a plain string assignment at the start of a line counts: nothing that could be code. */
function dunderValue(source: string, name: string): string | undefined {
  const match = new RegExp(`^__${name}__\\s*=\\s*["']([^"'\\\\\\r\\n]*)["']\\s*$`, 'm').exec(source)
  const value = match?.[1]?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}

export function readToolAttribution(source: string): Attribution {
  return toAttribution((field) => dunderValue(source, field))
}

/**
 * Where module-level assignments may go without breaking the file.
 *
 * After the shebang, comments and the PEP 723 block; after the module docstring, which stops being
 * the docstring if anything precedes it; and after `from __future__` imports, which Python requires
 * to come first. Returns a line index to insert *before*.
 */
function insertionLine(lines: readonly string[]): number {
  let index = 0
  const skipBlankAndComments = (): void => {
    while (index < lines.length && /^\s*(#.*)?$/.test(lines[index] ?? '')) index += 1
  }
  skipBlankAndComments()

  const docstring = /^[rRuU]?("""|''')/.exec(lines[index] ?? '')
  if (docstring !== null) {
    const quote = docstring[1] as string
    const opening = lines[index] ?? ''
    const rest = opening.slice(opening.indexOf(quote) + 3)
    index += 1
    if (!rest.includes(quote)) {
      while (index < lines.length && !(lines[index] ?? '').includes(quote)) index += 1
      index += 1
    }
    const afterDocstring = index
    skipBlankAndComments()
    if (!/^from\s+__future__\s+import\b/.test(lines[index] ?? '')) index = afterDocstring
  }
  while (/^from\s+__future__\s+import\b/.test(lines[index] ?? '')) index += 1
  return Math.min(index, lines.length)
}

function writeToolFields(source: string, values: Attribution, replace: ReadonlySet<Field>): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  let text = source
  const additions: string[] = []
  for (const field of FIELDS) {
    const value = cleanAttributionValue(values[field])
    if (value === undefined) continue
    const assignment = `__${field}__ = "${value}"`
    const plain = new RegExp(`^__${field}__\\s*=\\s*["'][^"'\\\\\\r\\n]*["']\\s*$`, 'm')
    if (plain.test(text)) {
      if (replace.has(field)) text = text.replace(plain, assignment)
    } else if (!new RegExp(`^__${field}__\\s*=`, 'm').test(text)) {
      // A non-literal assignment of the same name is somebody's code, and is left alone.
      additions.push(assignment)
    }
  }
  if (additions.length === 0) return text

  const lines = text.split(/\r?\n/)
  const at = insertionLine(lines)
  const before = lines.slice(0, at)
  const after = lines.slice(at)
  const existingBlock = /^__(author|project|version|updated)__\s*=/.test(after[0] ?? '')
  const block = [
    ...(before.length > 0 && (before[before.length - 1] ?? '').trim() !== '' ? [''] : []),
    ...additions,
    ...(after.length > 0 && (after[0] ?? '').trim() !== '' && !existingBlock ? [''] : []),
  ]
  return [...before, ...block, ...after].join(eol)
}

// -------------------------------------------------------------------------------------------------
// The two operations

export type AttributedKind = 'skill' | 'tool'

export function readAttribution(kind: AttributedKind, source: string): Attribution {
  return kind === 'skill' ? readSkillAttribution(source) : readToolAttribution(source)
}

/**
 * Labels a file that has never been labelled: every missing field is filled, nothing replaced.
 * `updated` should be the file's own modification time — the last time it actually changed.
 */
export function fillAttribution(kind: AttributedKind, source: string, values: Attribution): string {
  const none = new Set<Field>()
  return kind === 'skill' ? writeSkillFields(source, values, none) : writeToolFields(source, values, none)
}

/**
 * The labels for a save Light Code is making.
 *
 * `previous` is the file being replaced, if any. Author and project come from the new text, then
 * the old file, then — **only for a new file** — `defaults`; the version is one more than the
 * highest either file names (a file that existed without a version counts as 1); `updated` is `now`.
 */
export function stampRevision(
  kind: AttributedKind,
  source: string,
  previous: string | undefined,
  defaults: { author?: string | undefined; project?: string | undefined },
  now: Date,
): string {
  const incoming = readAttribution(kind, source)
  const before = previous === undefined ? {} : readAttribution(kind, previous)
  const priorVersion = Math.max(before.version ?? (previous === undefined ? 0 : 1), 0)
  const version = Math.max(priorVersion + 1, incoming.version ?? 0)
  /*
   * The defaults label only a file that is new. An existing file without a label may be anybody's —
   * copied from a colleague, synced from a shared bucket — and whoever happens to save it next is
   * not evidence of who wrote it. It keeps whatever it says, and stays unlabelled otherwise.
   */
  const isNew = previous === undefined
  const values: Attribution = {
    author: incoming.author ?? before.author ?? (isNew ? defaults.author : undefined),
    project: incoming.project ?? before.project ?? (isNew ? defaults.project : undefined),
    version,
    updated: attributionTimestamp(now),
  }
  const replace = new Set<Field>(['version', 'updated'])
  return kind === 'skill' ? writeSkillFields(source, values, replace) : writeToolFields(source, values, replace)
}

/** Which fields a file is missing, for the preview of labelling existing files. */
export function missingAttribution(kind: AttributedKind, source: string): Field[] {
  const present = readAttribution(kind, source)
  return FIELDS.filter((field) => present[field] === undefined)
}
