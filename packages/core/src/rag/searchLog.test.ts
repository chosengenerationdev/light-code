import { describe, expect, it } from 'vitest'
import { SearchLog, type SearchLogEntry } from './searchLog.js'

function entry(query: string, overrides: Partial<SearchLogEntry> = {}): SearchLogEntry {
  return { at: Date.now(), source: 'search_docs', query, hits: 1, elapsedMs: 5, ...overrides }
}

describe('SearchLog', () => {
  it('keeps the newest first, because that is the one being debugged', () => {
    const log = new SearchLog()
    log.record(entry('first'))
    log.record(entry('second'))

    expect(log.list().map((item) => item.query)).toEqual(['second', 'first'])
  })

  /** Bounded: a long session must not accumulate a session's worth of queries in memory. */
  it('discards the oldest past its limit', () => {
    const log = new SearchLog(3)
    for (const query of ['a', 'b', 'c', 'd']) log.record(entry(query))

    expect(log.list().map((item) => item.query)).toEqual(['d', 'c', 'b'])
  })

  it('notifies on every change, so the panel never shows a stale list', () => {
    let notifications = 0
    const log = new SearchLog(10, () => (notifications += 1))

    log.record(entry('a'))
    log.clear()

    expect(notifications).toBe(2)
    expect(log.list()).toEqual([])
  })

  /**
   * The distinction the panel exists for: a lexical result is indistinguishable from a
   * semantic one in the chat, so an index that is configured but never consulted is invisible
   * anywhere else.
   */
  it('carries whether the index was actually used', () => {
    const log = new SearchLog()
    log.record(entry('a', { via: 'lexical' }))
    log.record(entry('b', { via: 'index' }))

    expect(log.list().map((item) => item.via)).toEqual(['index', 'lexical'])
  })

  /** A failed search is exactly the one worth seeing; the transcript shows only the reaction. */
  it('records failures alongside successes', () => {
    const log = new SearchLog()
    log.record(entry('broken', { hits: 0, error: 'cluster unreachable' }))

    expect(log.list()[0]).toMatchObject({ hits: 0, error: 'cluster unreachable' })
  })

  /** `list()` is read by the bridge and spread into a message; it must not be mutable state. */
  it('returns a list the caller cannot corrupt', () => {
    const log = new SearchLog()
    log.record(entry('a'))
    const first = log.list()
    log.record(entry('b'))

    expect(first.map((item) => item.query)).toEqual(['a'])
  })
})
