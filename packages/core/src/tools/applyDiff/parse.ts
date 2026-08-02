/**
 * Roo's marker format, which models are heavily trained on — see CLAUDE.md §7.
 *
 *   <<<<<<< SEARCH
 *   :start_line:42
 *   -------
 *     throw new Error("no user")
 *   =======
 *     throw new UnauthorizedError("no user")
 *   >>>>>>> REPLACE
 *
 * `:start_line:` is optional; when present it must be followed by a `-------`
 * separator before the SEARCH content begins.
 */
const SEARCH_MARKER = '<<<<<<< SEARCH'
const SEPARATOR = '======='
const REPLACE_MARKER = '>>>>>>> REPLACE'
const DASH_SEPARATOR = '-------'
const START_LINE_PATTERN = /^:start_line:(\d+)$/

export interface DiffBlock {
  startLine?: number
  search: string
  replace: string
}

export type ParseResult = { ok: true; blocks: DiffBlock[] } | { ok: false; error: string }

export function parseDiff(diffText: string): ParseResult {
  const lines = diffText.split('\n')
  const blocks: DiffBlock[] = []
  let i = 0

  while (i < lines.length) {
    if ((lines[i] ?? '').trim() === '') {
      i++
      continue
    }

    if (lines[i] !== SEARCH_MARKER) {
      return { ok: false, error: `Expected "${SEARCH_MARKER}" at line ${i + 1}, got: "${lines[i]}"` }
    }
    i++

    let startLine: number | undefined
    const startLineMatch = START_LINE_PATTERN.exec(lines[i] ?? '')
    if (startLineMatch !== null) {
      startLine = Number(startLineMatch[1])
      i++
      if (lines[i] !== DASH_SEPARATOR) {
        return { ok: false, error: `Expected "${DASH_SEPARATOR}" after ":start_line:" at line ${i + 1}.` }
      }
      i++
    }

    const searchLines: string[] = []
    while (i < lines.length && lines[i] !== SEPARATOR) {
      const line = lines[i] ?? ''
      if (line === SEARCH_MARKER || line === REPLACE_MARKER || START_LINE_PATTERN.test(line)) {
        return { ok: false, error: `Unexpected marker inside the SEARCH block at line ${i + 1}: "${line}"` }
      }
      searchLines.push(line)
      i++
    }
    if (i >= lines.length) {
      return { ok: false, error: `Missing "${SEPARATOR}" to end the SEARCH block.` }
    }
    i++ // consume the separator

    const replaceLines: string[] = []
    while (i < lines.length && lines[i] !== REPLACE_MARKER) {
      const line = lines[i] ?? ''
      // Reject :start_line: or other markers after the separator — a real failure mode
      // observed in Roo with some models.
      if (line === SEARCH_MARKER || line === SEPARATOR || START_LINE_PATTERN.test(line)) {
        return { ok: false, error: `Unexpected marker inside the REPLACE block at line ${i + 1}: "${line}"` }
      }
      replaceLines.push(line)
      i++
    }
    if (i >= lines.length) {
      return { ok: false, error: `Missing "${REPLACE_MARKER}" to end the block.` }
    }
    i++ // consume the replace marker

    blocks.push({
      ...(startLine !== undefined ? { startLine } : {}),
      search: searchLines.join('\n'),
      replace: replaceLines.join('\n'),
    })
  }

  if (blocks.length === 0) {
    return { ok: false, error: 'No SEARCH/REPLACE blocks found.' }
  }

  return { ok: true, blocks }
}
