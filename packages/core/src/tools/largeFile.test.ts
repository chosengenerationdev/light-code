import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { countLines, formatBytes, readLineWindow, readTail } from './largeFile.js'

/**
 * Against real files on disk, not a stubbed filesystem.
 *
 * The whole point of this code is byte-range reads and chunk boundaries, and a fake that
 * returns whatever slice was asked for would prove none of it. These are small enough to be
 * fast and large enough to cross the 1MB chunk size, which is where the interesting bugs are.
 */

const filesystem = new NodeFileSystem()
let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-large-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(name: string, contents: string): Promise<{ file: string; size: number }> {
  const file = path.join(dir, name)
  await fs.writeFile(file, contents, 'utf8')
  return { file, size: (await fs.stat(file)).size }
}

/** Lines wide enough that a few thousand of them cross several read chunks. */
function log(count: number, width = 200): string {
  return (
    Array.from({ length: count }, (_, index) => `line ${String(index + 1)} ${'x'.repeat(width)}`).join('\n') + '\n'
  )
}

describe('readTail', () => {
  it('returns the last lines of a file spanning many chunks', async () => {
    const { file, size } = await write('big.log', log(20_000))
    expect(size).toBeGreaterThan(1 << 20)

    const part = await readTail(filesystem, file, size, 5)

    expect(part.lines).toHaveLength(5)
    expect(part.lines[4]).toContain('line 20000 ')
    expect(part.lines[0]).toContain('line 19996 ')
    expect(part.hasMoreBefore).toBe(true)
  })

  /**
   * A backward read almost always begins mid-line. Returning that fragment as though it were
   * a line would put a truncated record in front of the model as fact.
   */
  it('never returns a partial first line', async () => {
    const { file, size } = await write('big.log', log(20_000))
    const part = await readTail(filesystem, file, size, 3)

    for (const line of part.lines) expect(line).toMatch(/^line \d+ x+$/)
  })

  it('returns the whole file when asked for more lines than it has', async () => {
    const { file, size } = await write('small.log', 'a\nb\nc\n')
    const part = await readTail(filesystem, file, size, 100)

    expect(part.lines).toEqual(['a', 'b', 'c'])
    expect(part.hasMoreBefore).toBe(false)
  })

  /** A log with very long lines must not need one read per line to satisfy a small tail. */
  it('copes with lines longer than the read chunk', async () => {
    const { file, size } = await write('wide.log', `${'a'.repeat(3 << 20)}\nlast line\n`)
    const part = await readTail(filesystem, file, size, 1)

    expect(part.lines).toEqual(['last line'])
  })

  /**
   * Decoding each chunk independently would corrupt any character straddling a boundary —
   * rare enough to pass a casual test and certain in a real log with accented names.
   */
  it('keeps multi-byte characters intact across chunk boundaries', async () => {
    const { file, size } = await write('utf8.log', `${log(9_000)}café — naïve — 日本語\n`)
    const part = await readTail(filesystem, file, size, 1)

    expect(part.lines[0]).toBe('café — naïve — 日本語')
    expect(part.lines[0]).not.toContain('�')
  })
})

describe('readLineWindow', () => {
  it('returns the requested window with correct numbering', async () => {
    const { file, size } = await write('big.log', log(20_000))
    const part = await readLineWindow(filesystem, file, size, 15_000, 4)

    expect(part.firstLineNumber).toBe(15_000)
    expect(part.lines).toHaveLength(4)
    expect(part.lines[0]).toContain('line 15000 ')
    expect(part.lines[3]).toContain('line 15003 ')
    expect(part.hasMoreBefore).toBe(true)
    expect(part.hasMoreAfter).toBe(true)
  })

  it('reports the end of the file rather than claiming more follows', async () => {
    const { file, size } = await write('big.log', log(5_000))
    const part = await readLineWindow(filesystem, file, size, 4_998, 50)

    expect(part.lines).toHaveLength(3)
    expect(part.hasMoreAfter).toBe(false)
  })

  it('reads from the very start', async () => {
    const { file, size } = await write('big.log', log(5_000))
    const part = await readLineWindow(filesystem, file, size, 1, 2)

    expect(part.lines[0]).toContain('line 1 ')
    expect(part.hasMoreBefore).toBe(false)
  })

  it('returns nothing when the window is past the end', async () => {
    const { file, size } = await write('small.log', 'a\nb\n')
    expect((await readLineWindow(filesystem, file, size, 99, 10)).lines).toEqual([])
  })

  it('keeps multi-byte characters intact across chunk boundaries', async () => {
    const { file, size } = await write('utf8.log', `${log(9_000)}café — naïve — 日本語\n`)
    const part = await readLineWindow(filesystem, file, size, 9_001, 1)

    expect(part.lines[0]).toBe('café — naïve — 日本語')
  })
})

describe('countLines', () => {
  it('counts a multi-chunk file', async () => {
    const { file, size } = await write('big.log', log(20_000))
    expect(await countLines(filesystem, file, size)).toBe(20_000)
  })

  /** A file with no trailing newline still has a final line. */
  it('counts a final line with no trailing newline', async () => {
    const { file, size } = await write('a.log', 'one\ntwo')
    expect(await countLines(filesystem, file, size)).toBe(2)
  })

  it('reports zero for an empty file', async () => {
    const { file, size } = await write('empty.log', '')
    expect(await countLines(filesystem, file, size)).toBe(0)
  })
})

describe('formatBytes', () => {
  it('scales to a unit a human reads at a glance', () => {
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(2048)).toBe('2.0KB')
    expect(formatBytes(5 << 20)).toBe('5.0MB')
    // `<<` is 32-bit and 3 << 30 overflows negative — a trap worth not writing twice.
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0GB')
  })
})
