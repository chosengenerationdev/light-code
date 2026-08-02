import { detectEol, normalizeToLf, restoreEol } from './eol.js'
import { findMatch } from './match.js'
import { parseDiff } from './parse.js'

export interface ApplyDiffResult {
  ok: boolean
  content: string
  message: string
}

/**
 * All blocks are validated against the original content before any write — partial
 * application is forbidden. See CLAUDE.md §7.
 */
export function applyDiff(originalContent: string, diffText: string): ApplyDiffResult {
  const parsed = parseDiff(diffText)
  if (!parsed.ok) {
    return { ok: false, content: originalContent, message: parsed.error }
  }

  const eol = detectEol(originalContent)
  const lines = normalizeToLf(originalContent).split('\n')

  const resolved: { startLine: number; endLine: number; replace: string }[] = []
  for (const block of parsed.blocks) {
    const match = findMatch(lines, block)
    if (!match.ok) {
      return { ok: false, content: originalContent, message: match.message }
    }
    resolved.push(match)
  }

  // Apply bottom-up so earlier (lower-numbered) blocks' positions stay valid as later ones shift the content.
  const bottomUp = [...resolved].sort((a, b) => b.startLine - a.startLine)
  const nextLines = [...lines]
  for (const block of bottomUp) {
    const replaceLines = block.replace.length > 0 ? block.replace.split('\n') : ['']
    nextLines.splice(block.startLine, block.endLine - block.startLine + 1, ...replaceLines)
  }

  return {
    ok: true,
    content: restoreEol(nextLines.join('\n'), eol),
    message: `Applied ${parsed.blocks.length} block(s).`,
  }
}
