import type { DiffBlock } from './parse.js'

export interface MatchResult {
  ok: true
  /** 0-based, inclusive line range in the file to replace. */
  startLine: number
  endLine: number
  /** Replace content with indentation adjusted to match the file at the match site. */
  replace: string
}

export interface MatchFailure {
  ok: false
  reason: 'not-found' | 'not-unique' | 'empty-search'
  message: string
}

/**
 * The matching cascade — deterministic, in order, no fuzzy scoring. See CLAUDE.md §7:
 * this is a deliberate divergence from Roo's Levenshtein matcher, which produced both
 * false rejections and the risk of silent misapplication. Do not add a similarity
 * threshold without an explicit decision from the user.
 */
export function findMatch(fileLines: string[], block: DiffBlock): MatchResult | MatchFailure {
  const searchLines = block.search.split('\n')
  if (searchLines.length === 1 && searchLines[0] === '') {
    return { ok: false, reason: 'empty-search', message: 'SEARCH block is empty.' }
  }

  // Tier 1: exact match after normalising line endings to \n (already done by the caller).
  const exact = disambiguateByHint(findRuns(fileLines, searchLines, linesEqual), block.startLine)
  if (exact.length === 1) return buildMatch(fileLines, searchLines, block.replace, exact[0] as number)
  if (exact.length > 1) {
    return {
      ok: false,
      reason: 'not-unique',
      message: `SEARCH block matches ${exact.length} locations; add more surrounding context to make it unique.`,
    }
  }

  // Tier 2: whitespace-insensitive — compare stripped lines, apply using the file's own indentation.
  const ws = disambiguateByHint(findRuns(fileLines, searchLines, whitespaceInsensitiveEqual), block.startLine)
  if (ws.length === 1) return buildMatch(fileLines, searchLines, block.replace, ws[0] as number)
  if (ws.length > 1) {
    return {
      ok: false,
      reason: 'not-unique',
      message: `SEARCH block matches ${ws.length} locations when ignoring whitespace; add more context.`,
    }
  }

  // Tier 3: anchor match (5+ line blocks only) — first/last line match, interior may have drifted.
  if (searchLines.length >= 5) {
    const anchors = disambiguateByHint(findAnchorRuns(fileLines, searchLines), block.startLine)
    if (anchors.length === 1) return buildMatch(fileLines, searchLines, block.replace, anchors[0] as number)
    if (anchors.length > 1) {
      return {
        ok: false,
        reason: 'not-unique',
        message: `SEARCH block's first/last lines match ${anchors.length} locations; add more context.`,
      }
    }
  }

  // Tier 4: fail, with the current text near the hint so the model can retry with correct context.
  return { ok: false, reason: 'not-found', message: `SEARCH block was not found in the file.${contextSnippet(fileLines, block.startLine, searchLines.length)}` }
}

function buildMatch(fileLines: string[], searchLines: string[], replace: string, start: number): MatchResult {
  const end = start + searchLines.length - 1
  const targetIndent = indentOf(fileLines[start] ?? '')
  const searchFirstIndent = indentOf(searchLines[0] ?? '')
  const reindented = reindent(replace.split('\n'), searchFirstIndent, targetIndent).join('\n')
  return { ok: true, startLine: start, endLine: end, replace: reindented }
}

function linesEqual(a: string, b: string): boolean {
  return a === b
}

function stripLine(line: string): string {
  return line.trim()
}

function whitespaceInsensitiveEqual(a: string, b: string): boolean {
  return stripLine(a) === stripLine(b)
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

/** Shifts every REPLACE line by the same amount the file's indentation differs from the SEARCH block's. */
function reindent(replaceLines: string[], searchFirstIndent: string, targetIndent: string): string[] {
  if (searchFirstIndent === targetIndent) return replaceLines
  return replaceLines.map((line) => (line.startsWith(searchFirstIndent) ? targetIndent + line.slice(searchFirstIndent.length) : line))
}

function findRuns(fileLines: string[], searchLines: string[], eq: (a: string, b: string) => boolean): number[] {
  const results: number[] = []
  for (let start = 0; start + searchLines.length <= fileLines.length; start++) {
    let matched = true
    for (let j = 0; j < searchLines.length; j++) {
      if (!eq(fileLines[start + j] ?? '', searchLines[j] ?? '')) {
        matched = false
        break
      }
    }
    if (matched) results.push(start)
  }
  return results
}

function findAnchorRuns(fileLines: string[], searchLines: string[]): number[] {
  const results: number[] = []
  const first = searchLines[0] ?? ''
  const last = searchLines[searchLines.length - 1] ?? ''
  for (let start = 0; start + searchLines.length <= fileLines.length; start++) {
    const end = start + searchLines.length - 1
    if (whitespaceInsensitiveEqual(fileLines[start] ?? '', first) && whitespaceInsensitiveEqual(fileLines[end] ?? '', last)) {
      results.push(start)
    }
  }
  return results
}

/**
 * `:start_line:` is a hint used to prioritise search order, not a requirement — CLAUDE.md
 * §7. When multiple matches exist and a hint is given, trust it: pick the single closest
 * match rather than requiring the hint to already disambiguate unassisted.
 */
function disambiguateByHint(matches: number[], startLineHint: number | undefined): number[] {
  if (matches.length <= 1 || startLineHint === undefined) return matches
  const hinted = startLineHint - 1
  let closest = matches[0] as number
  let closestDistance = Math.abs(closest - hinted)
  for (const candidate of matches) {
    const distance = Math.abs(candidate - hinted)
    if (distance < closestDistance) {
      closest = candidate
      closestDistance = distance
    }
  }
  return [closest]
}

function contextSnippet(fileLines: string[], hintLine: number | undefined, span: number): string {
  if (hintLine === undefined) return ''
  const center = hintLine - 1
  const start = Math.max(0, center - 3)
  const end = Math.min(fileLines.length, center + span + 3)
  const snippet = fileLines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}\t${line}`)
    .join('\n')
  return `\n\nCurrent content near line ${hintLine}:\n${snippet}`
}
