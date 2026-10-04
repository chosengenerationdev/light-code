import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { searchMentions, type MentionIndex } from './mentionSearch.js'

/**
 * A file index that behaves like the real one when a query matches thousands of files: it returns
 * the first `limit` it comes across, in its own order - here, job scripts first.
 */
function index(files: string[]): MentionIndex {
  return async (segment, limit, _excludes, mode, depth) => {
    const needle = segment.toLowerCase()
    return files
      .filter((f) => {
        const relative = f.split('/')
        const name = (relative.at(-1) ?? '').toLowerCase()
        if (depth !== undefined && relative.length - 1 !== depth) return false
        return mode === 'prefix' ? name.startsWith(needle) : name.includes(needle)
      })
      .slice(0, limit)
      .map((f) => path.join('/repo', f))
  }
}

describe('the @ picker in a large codebase', () => {
  const scripts = Array.from({ length: 3000 }, (_, i) => `fct/src/jobs/bat/abc_job_${String(i).padStart(4, '0')}.bat`)

  /** Reported from real use: `@abc` showed only the job scripts. */
  it('finds the source file even when the first scan is full of other matches', async () => {
    const files = [...scripts, 'fct/src/jobs/bat/abc_report.bat', 'fct/src/abc/abc_report.py']
    const found = await searchMentions(index(files), '/repo', 'abc', [], 2000, 30)
    expect(found).toContain('fct/src/abc/abc_report.py')
    expect(found[0]).toBe('fct/src/abc/abc_report.py') // shallower than every script
  })

  it('does not run the second pass when the first scan saw everything', async () => {
    let calls = 0
    const counting: MentionIndex = async (...args) => {
      calls++
      return index(['fct/src/abc/abc_report.py', 'fct/src/jobs/bat/abc_report.bat'])(...args)
    }
    expect(await searchMentions(counting, '/repo', 'abc', [], 2000, 30)).toEqual([
      'fct/src/abc/abc_report.py',
      'fct/src/jobs/bat/abc_report.bat',
    ])
    expect(calls).toBe(1)
  })
})
