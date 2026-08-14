import { StringDecoder } from 'node:string_decoder'
import type { FileSystem } from '../platform/filesystem.js'

/**
 * Reading a file in parts, for logs too large to hold in memory.
 *
 * `readFile` does not merely use a lot of memory on a multi-gigabyte log — it exceeds V8's
 * maximum string length and throws. So `offset`/`limit` alone cannot rescue it: the whole read
 * happens before any slicing. These read only the bytes the requested window needs.
 *
 * A `StringDecoder` carries partial UTF-8 sequences across chunk boundaries. Decoding each
 * chunk independently would corrupt any character that straddles one — rare enough to pass a
 * casual test and certain to appear in a large log with accented names or emoji.
 */

/** Bytes per read. Large enough that a scan is not thousands of syscalls, small enough to hold. */
const CHUNK = 1 << 20

/** Below this a file is read whole: simpler, faster, and gives exact line numbers. */
export const SMALL_FILE_BYTES = 4 * 1024 * 1024

export interface FilePart {
  lines: string[]
  /**
   * 1-based line number of `lines[0]`, when it is known.
   *
   * Absent for a tail of a large file: finding the absolute number would mean scanning the
   * whole file from the start, which is the cost this exists to avoid. Better to say the
   * numbers are unknown than to invent them.
   */
  firstLineNumber?: number
  /** True when there is more before the returned window. */
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export function formatBytes(size: number): string {
  if (size >= 1 << 30) return `${(size / (1 << 30)).toFixed(1)}GB`
  if (size >= 1 << 20) return `${(size / (1 << 20)).toFixed(1)}MB`
  if (size >= 1 << 10) return `${(size / (1 << 10)).toFixed(1)}KB`
  return `${String(size)}B`
}

/**
 * The last `count` lines.
 *
 * Reads backwards in growing steps until enough newlines have been seen, so the cost is
 * proportional to the tail requested rather than to the file. The first line of the window is
 * dropped unless the file's very start was reached — a backward read almost always begins
 * mid-line, and returning that fragment as though it were a line is worse than omitting it.
 */
export async function readTail(fs: FileSystem, path: string, size: number, count: number): Promise<FilePart> {
  let span = Math.min(size, CHUNK)
  let text: string
  let start: number

  for (;;) {
    start = Math.max(0, size - span)
    const decoder = new StringDecoder('utf8')
    text = decoder.write(await fs.readBytesSlice(path, start, size)) + decoder.end()

    const enough = text.split('\n').length > count
    if (enough || start === 0 || span >= size) break
    // Doubling rather than stepping: a log with very long lines would otherwise take many
    // reads to satisfy a modest tail.
    span = Math.min(size, span * 4)
  }

  const all = text.split(/\r\n|\r|\n/)
  // A read that began mid-file starts mid-line; that fragment is not a line.
  if (start > 0 && all.length > 0) all.shift()
  // A trailing newline yields a final empty element that is not a line either.
  if (all.length > 0 && all[all.length - 1] === '') all.pop()

  const lines = all.slice(-count)
  return {
    lines,
    hasMoreBefore: start > 0 || all.length > lines.length,
    hasMoreAfter: false,
  }
}

/**
 * A window of `count` lines starting at `from` (1-based).
 *
 * Scans forward from the start because a line offset cannot be turned into a byte offset
 * without counting newlines. Only the wanted lines are retained, so memory stays bounded
 * however far into the file the window sits.
 */
export async function readLineWindow(
  fs: FileSystem,
  path: string,
  size: number,
  from: number,
  count: number,
): Promise<FilePart> {
  const decoder = new StringDecoder('utf8')
  const lines: string[] = []
  let pending = ''
  let lineNumber = 1
  let position = 0
  let reachedEnd = true

  const take = (line: string): boolean => {
    if (lineNumber >= from && lines.length < count) lines.push(line)
    lineNumber += 1
    // Stop as soon as the window is full; the rest of the file is never read.
    return lines.length >= count && lineNumber > from
  }

  scan: while (position < size) {
    const end = Math.min(size, position + CHUNK)
    pending += decoder.write(await fs.readBytesSlice(path, position, end))
    position = end

    const parts = pending.split(/\r\n|\r|\n/)
    // The final part may be an incomplete line, so it is held back for the next chunk.
    pending = parts.pop() ?? ''
    for (const line of parts) {
      if (take(line)) {
        reachedEnd = false
        break scan
      }
    }
  }

  if (reachedEnd) {
    pending += decoder.end()
    if (pending.length > 0) take(pending)
  }

  return {
    lines,
    firstLineNumber: from,
    hasMoreBefore: from > 1,
    hasMoreAfter: !reachedEnd || lineNumber > from + lines.length,
  }
}

/** Counts lines without building them, for a file small enough that the scan is quick. */
export async function countLines(fs: FileSystem, path: string, size: number): Promise<number> {
  let newlines = 0
  let position = 0
  let lastByte = -1

  while (position < size) {
    const end = Math.min(size, position + CHUNK)
    const buffer = await fs.readBytesSlice(path, position, end)
    for (const byte of buffer) if (byte === 0x0a) newlines += 1
    if (buffer.length > 0) lastByte = buffer[buffer.length - 1] ?? lastByte
    position = end
  }

  if (lastByte < 0) return 0
  /*
   * A trailing newline terminates the last line rather than starting another. Adding one
   * unconditionally reported every well-formed log as a line longer than it is — and that
   * number is what the refusal message offers as a starting offset, so it would have sent
   * every follow-up read one line past the end.
   */
  return lastByte === 0x0a ? newlines : newlines + 1
}
