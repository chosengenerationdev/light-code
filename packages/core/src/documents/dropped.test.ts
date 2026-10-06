import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeFileName, stageDroppedFile } from './dropped.js'

/*
 * Reported: dropping a file or an Outlook message said it was too big and asked for it to be
 * saved locally. These pin the replacement: whatever is dropped is saved and read, and a large
 * one is cut with a path read_file can follow - never refused.
 */
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-drop-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('stageDroppedFile', () => {
  it('reads a large text file, cuts it, and says where the rest is', async () => {
    const big = 'line of log output\n'.repeat(50_000)
    const staged = await stageDroppedFile(dir, 'server.log', Buffer.from(big), { textCap: 1000 })
    expect(staged.truncated).toBe(true)
    expect(staged.text.length).toBeLessThan(1300)
    expect(staged.text).toContain(staged.path)
    expect(staged.text).toContain('read_file')
    expect(await fs.readFile(staged.path, 'utf8')).toBe(big)
  })

  it('reads an Outlook message dropped from Outlook', async () => {
    const msg = await fs.readFile(path.join(import.meta.dirname, 'fixtures', 'reconciliation.msg'))
    const staged = await stageDroppedFile(dir, 'Q3 reconciliation.msg', msg)
    expect(staged.text).toContain('Alex Whitfield')
    expect(staged.text).toContain('reconciliation-q3.xlsx')
    expect(staged.truncated).toBe(false)
  })

  it('says a binary file it cannot read is saved, rather than pasting bytes', async () => {
    const staged = await stageDroppedFile(dir, 'tool.bin', Buffer.from([0, 1, 2, 3, 0, 255]))
    expect(staged.text).toMatch(/not a format Light Code can read as text/)
    expect(staged.text).toContain(staged.path)
  })

  it('never replaces a file dropped earlier with the same name', async () => {
    const first = await stageDroppedFile(dir, 'notes.txt', Buffer.from('first'))
    const second = await stageDroppedFile(dir, 'notes.txt', Buffer.from('second'))
    expect(second.path).not.toBe(first.path)
    expect(await fs.readFile(first.path, 'utf8')).toBe('first')
  })

  it('keeps a hostile name inside the folder', async () => {
    expect(safeFileName('..\\..\\evil.txt')).not.toContain('\\')
    const staged = await stageDroppedFile(dir, '../../evil.txt', Buffer.from('x'))
    expect(path.dirname(staged.path)).toBe(dir)
  })
})
