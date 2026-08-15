export type DiffLineKind = 'context' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based line number in the original file; absent for added lines. */
  beforeLine?: number
  /** 1-based line number in the new file; absent for removed lines. */
  afterLine?: number
}

/**
 * Line-level LCS diff. Deliberately dependency-free — this renders the *approval* view, so
 * a small amount of code we fully control is preferable to a library for something the
 * user relies on to decide whether an edit is safe.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i] as number[]
      const nextRow = table[i + 1] as number[]
      row[j] = a[i] === b[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number)
    }
  }
  return table
}

/**
 * Splits into lines, treating an empty string as **no lines at all**.
 *
 * `''.split('\n')` returns `['']` — one empty line, not zero. For a new file that phantom line
 * reaches the matcher, which pairs it with the first genuinely blank line in the new content
 * and reports that line as *unchanged*. The approval prompt then showed a row of a brand-new
 * file as context, numbered against a file that does not exist, and the rest of the numbering
 * read as though a line had been skipped.
 *
 * Invariant 8 is why this matters more than it looks: the diff is what the user reads to decide
 * whether an edit is safe, so a row claiming "this line was already there" about a file being
 * created is the prompt misreporting ground truth.
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  // Normalise CRLF so a line-ending difference doesn't render as every line changed.
  return text.replace(/\r\n/g, '\n').split('\n')
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const table = lcsTable(a, b)

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'context', text: a[i] as string, beforeLine: i + 1, afterLine: j + 1 })
      i++
      j++
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: 'removed', text: a[i] as string, beforeLine: i + 1 })
      i++
    } else {
      lines.push({ kind: 'added', text: b[j] as string, afterLine: j + 1 })
      j++
    }
  }
  while (i < a.length) {
    lines.push({ kind: 'removed', text: a[i] as string, beforeLine: i + 1 })
    i++
  }
  while (j < b.length) {
    lines.push({ kind: 'added', text: b[j] as string, afterLine: j + 1 })
    j++
  }
  return lines
}

/** Collapses long runs of unchanged lines so a large file's small edit stays readable. */
export function collapseContext(lines: DiffLine[], contextLines = 3): (DiffLine | { kind: 'gap'; count: number })[] {
  const changed = new Set<number>()
  lines.forEach((line, index) => {
    if (line.kind !== 'context') {
      for (let k = index - contextLines; k <= index + contextLines; k++) changed.add(k)
    }
  })

  const out: (DiffLine | { kind: 'gap'; count: number })[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (changed.has(index)) {
      if (skipped > 0) {
        out.push({ kind: 'gap', count: skipped })
        skipped = 0
      }
      out.push(line)
    } else {
      skipped += 1
    }
  })
  if (skipped > 0) out.push({ kind: 'gap', count: skipped })
  return out
}
