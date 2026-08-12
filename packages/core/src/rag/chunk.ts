/**
 * Line-window chunking with overlap.
 *
 * Deliberately not symbol-aware — that needs a parser per language, and the plan puts it out
 * of this phase. A line window is worth more than it sounds: the boundaries map straight back
 * to a citable `path:start-end`, so a hit tells the model where to `read_file` next rather
 * than handing it a detached fragment.
 *
 * Windows overlap because the alternative loses whatever straddles a boundary. A function
 * whose signature ends one chunk and whose body starts the next matches poorly in both; with
 * overlap it appears intact in at least one.
 */

export interface Chunk {
  text: string
  /** 1-based and inclusive, matching how editors and `read_file` count. */
  startLine: number
  endLine: number
}

export interface ChunkOptions {
  /** Lines per window. */
  windowLines?: number
  /** Lines repeated between consecutive windows. Must be less than `windowLines`. */
  overlapLines?: number
  /**
   * Hard character cap per chunk, applied after the line window.
   *
   * A line window alone is not enough: a minified bundle or a generated file can be one
   * line of two megabytes, which would sail through the line check and then be rejected by
   * the embedding endpoint — or worse, accepted and billed for.
   */
  maxChars?: number
}

export const DEFAULT_CHUNK_OPTIONS = {
  windowLines: 60,
  overlapLines: 15,
  maxChars: 4_000,
} as const

/**
 * A file worth embedding at all.
 *
 * The NUL check is a cheap, reliable binary test — text encodings do not contain NUL, and
 * every common binary format does within its first few hundred bytes. Cheaper and more
 * accurate than trusting the extension, which lies both ways: `.dat` is sometimes text and
 * `.json` is sometimes a 40MB fixture.
 */
export function looksLikeText(content: string): boolean {
  return !content.slice(0, 8_000).includes('\0')
}

export function chunkFile(content: string, options: ChunkOptions = {}): Chunk[] {
  const windowLines = options.windowLines ?? DEFAULT_CHUNK_OPTIONS.windowLines
  const overlapLines = Math.min(options.overlapLines ?? DEFAULT_CHUNK_OPTIONS.overlapLines, windowLines - 1)
  const maxChars = options.maxChars ?? DEFAULT_CHUNK_OPTIONS.maxChars
  const step = Math.max(1, windowLines - overlapLines)

  // Normalised so a CRLF file chunks identically to the same file with LF endings —
  // otherwise the content hash differs per checkout and every file reindexes on a machine
  // with different git settings (§7, §16).
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const chunks: Chunk[] = []

  for (let start = 0; start < lines.length; start += step) {
    const window = lines.slice(start, start + windowLines)
    const text = window.join('\n')
    // Whitespace-only windows carry no meaning and would still cost an embedding call.
    if (text.trim().length === 0) continue

    if (text.length <= maxChars) {
      chunks.push({ text, startLine: start + 1, endLine: start + window.length })
    } else {
      // Over the cap: split by characters instead, keeping the line range honest by
      // attributing every piece to the whole window. Imprecise, but this only happens for
      // files with pathologically long lines, where a precise range means little anyway.
      for (let offset = 0; offset < text.length; offset += maxChars) {
        const piece = text.slice(offset, offset + maxChars)
        if (piece.trim().length === 0) continue
        chunks.push({ text: piece, startLine: start + 1, endLine: start + window.length })
      }
    }

    // `slice` clamps, so the final window is short and this is what ends the loop.
    if (start + windowLines >= lines.length) break
  }

  return chunks
}
