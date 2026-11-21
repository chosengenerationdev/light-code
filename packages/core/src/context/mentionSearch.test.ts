import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { searchMentions, type MentionIndex } from './mentionSearch.js'

/**
 * A file index that behaves like the real one when a query matches thousands of files: it returns
 * the first `limit` it comes across, in its own order - here, job scripts first.
 */
function index(files: string[]): MentionIndex {
  return async (segment, limit, _excludes, mode, depth, root) => {
    const needle = segment.toLowerCase()
    const under = root === undefined ? '' : `${path.relative('/repo', root).split(path.sep).join('/')}/`
    const inRoot = files.filter((f) => f.startsWith(under)).map((f) => f.slice(under.length))
    if (mode === 'folders') {
      const folders = new Set<string>()
      for (const f of inRoot) {
        const parts = f.split('/')
        for (let i = 0; i < parts.length - 1; i++) {
          if ((parts[i] ?? '').toLowerCase().includes(needle)) folders.add(parts.slice(0, i + 1).join('/'))
        }
      }
      return [...folders].slice(0, limit).map((f) => path.join('/repo', under, f))
    }
    return inRoot
      .filter((f) => {
        const relative = f.split('/')
        const name = (relative.at(-1) ?? '').toLowerCase()
        if (depth !== undefined && relative.length - 1 !== depth) return false
        return mode === 'prefix' ? name.startsWith(needle) : name.includes(needle)
      })
      .slice(0, limit)
      .map((f) => path.join('/repo', under, f))
  }
}

describe('the @ picker in a large codebase', () => {
  const scripts = Array.from({ length: 3000 }, (_, i) => `fct/src/jobs/bat/abc_job_${String(i).padStart(4, '0')}.bat`)

  /** Reported from real use: `@abc` showed only the job scripts. */
  it('finds the source file even when the first scan is full of other matches', async () => {
    const files = [...scripts, 'fct/src/jobs/bat/abc_report.bat', 'fct/src/abc/abc_report.py']
    const found = await searchMentions(index(files), '/repo', 'abc', [], 2000, 30)
    expect(found).toContain('fct/src/abc/abc_report.py')
    // The folder named exactly that, then the file - shallower than every script.
    expect(found.slice(0, 2)).toEqual(['fct/src/abc/', 'fct/src/abc/abc_report.py'])
  })

  it('does not run the second pass when the first scan saw everything', async () => {
    let calls = 0
    const counting: MentionIndex = async (...args) => {
      calls++
      return index(['fct/src/abc/abc_report.py', 'fct/src/jobs/bat/abc_report.bat'])(...args)
    }
    expect(await searchMentions(counting, '/repo', 'abc', [], 2000, 30)).toEqual([
      'fct/src/abc/',
      'fct/src/abc/abc_report.py',
      'fct/src/jobs/bat/abc_report.bat',
    ])
    // The file scan, the folder-name scan, and a listing of the one matching folder; no prefix pass.
    expect(calls).toBe(3)
  })
})

/** Reported: "it is not considering directory names when i search". */
describe('folder names in the @ picker', () => {
  const files = ['src/quarterly/q3.xlsx', 'src/quarterly/notes.md', 'src/api.ts', 'docs/readme.md']

  it('offers a folder whose name matches, and the files in it, though no file name does', async () => {
    const found = await searchMentions(index(files), '/repo', 'quarter', [], 2000, 30)
    expect(found[0]).toBe('src/quarterly/')
    expect(found).toContain('src/quarterly/q3.xlsx')
    expect(found).toContain('src/quarterly/notes.md')
  })

  it('ranks a file named like the text above files that are only in a matching folder', async () => {
    const found = await searchMentions(index([...files, 'lib/quarter.py']), '/repo', 'quarter', [], 2000, 30)
    expect(found.indexOf('lib/quarter.py')).toBeLessThan(found.indexOf('src/quarterly/q3.xlsx'))
  })

  it('searches inside a folder that was typed', async () => {
    const found = await searchMentions(index([...files, 'other/q3.xlsx']), '/repo', 'src/quarterly/', [], 2000, 30)
    expect(found).toEqual(expect.arrayContaining(['src/quarterly/q3.xlsx', 'src/quarterly/notes.md']))
    expect(found).not.toContain('other/q3.xlsx')
  })

  it('never searches above the workspace from a typed path', async () => {
    const asked: (string | undefined)[] = []
    const spy: MentionIndex = async (...args) => {
      asked.push(args[5])
      return index(files)(...args)
    }
    await searchMentions(spy, '/repo', '../../etc/x', [], 2000, 30)
    expect(asked.every((root) => root === undefined || !path.relative('/repo', root).startsWith('..'))).toBe(true)
  })
})
