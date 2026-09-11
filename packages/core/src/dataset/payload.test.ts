import { describe, expect, it } from 'vitest'

import { parseDatasetPayload } from './types.js'

/**
 * Reading whatever a collector actually returned.
 *
 * Reported from real use: asked for a collector, the assistant wrote one that returned something
 * a person would read rather than something a search can index. Two halves to that — the model is
 * taught the contract now, and the parser forgives every shape that has exactly one sensible
 * reading while refusing, precisely, the ones that do not.
 *
 * **Shape is forgiven; content is not.** A list under a different noun, a lone dict, a JSON
 * string, `key` instead of `id`, a timestamp in seconds — each of those means one thing. A missing
 * id does not, and inventing one would put junk in the corpus that surfaces weeks later as bad
 * search results.
 */
function records(value: unknown) {
  const result = parseDatasetPayload(value)
  if ('error' in result) throw new Error(result.error)
  return result.records
}

describe('reading a collector result', () => {
  it('takes a plain list', () => {
    expect(records([{ id: 'a', text: 'one' }])).toHaveLength(1)
  })

  it('takes a list under any of the obvious nouns', () => {
    for (const key of ['records', 'items', 'data', 'results', 'rows']) {
      expect(records({ [key]: [{ id: 'a', text: 'one' }] })).toHaveLength(1)
    }
  })

  it('takes a lone dict as one record', () => {
    // Sources that return a single object are common; requiring brackets would be a rejection
    // about punctuation.
    expect(records({ id: 'a', text: 'one' })).toEqual([{ id: 'a', text: 'one' }])
  })

  it('takes JSON that was returned as a string', () => {
    // What somebody writes when they are thinking about printing rather than returning.
    expect(records(JSON.stringify([{ id: 'a', text: 'one' }]))).toHaveLength(1)
  })

  it('accepts key or _id as the identifier, and a number as one', () => {
    expect(records([{ key: 'TICKET-1', text: 'one' }])[0]?.id).toBe('TICKET-1')
    expect(records([{ _id: 7, text: 'one' }])[0]?.id).toBe('7')
  })

  it('accepts the usual names for a body', () => {
    for (const key of ['content', 'body', 'description', 'summary']) {
      expect(records([{ id: 'a', [key]: 'the meaning' }])[0]?.text).toBe('the meaning')
    }
  })

  it('reads a timestamp given in seconds as seconds', () => {
    /*
     * The mistake worth catching. Seconds parse fine, break nothing loudly, and date every record
     * to 1970 — so retention deletes the lot and "what changed this week" finds nothing, with no
     * error anywhere.
     */
    const seconds = 1_757_000_000
    expect(records([{ id: 'a', text: 'x', timestamp: seconds }])[0]?.timestamp).toBe(seconds * 1000)
  })

  it('leaves a millisecond timestamp alone', () => {
    const ms = 1_757_000_000_000
    expect(records([{ id: 'a', text: 'x', timestamp: ms }])[0]?.timestamp).toBe(ms)
  })

  it('reads an ISO date', () => {
    const parsed = records([{ id: 'a', text: 'x', timestamp: '2026-09-11T12:00:00Z' }])[0]?.timestamp
    expect(parsed).toBe(Date.parse('2026-09-11T12:00:00Z'))
  })

  it('accepts updated / updated_at / date as the timestamp', () => {
    for (const key of ['updated', 'updated_at', 'date']) {
      expect(records([{ id: 'a', text: 'x', [key]: '2026-09-11T12:00:00Z' }])[0]?.timestamp).toBeGreaterThan(0)
    }
  })

  it('coerces tag values to strings rather than refusing them', () => {
    const tags = records([{ id: 'a', text: 'x', tags: { open: true, count: 3 } }])[0]?.tags
    expect(tags).toEqual({ open: 'true', count: '3' })
  })

  it('takes an empty list as a successful empty sync', () => {
    expect(records([])).toEqual([])
  })
})

describe('refusing a collector result', () => {
  it('refuses prose, quoting what it got', () => {
    const result = parseDatasetPayload('Here are the 5 most recent tickets:\n- TICKET-1 …')
    expect('error' in result && result.error).toContain('returned text rather than records')
    expect('error' in result && result.error).toContain('Here are the 5 most recent')
  })

  it('refuses a record with no id, naming the keys it did have', () => {
    // "records.0.id: Required" tells nobody anything. The keys it actually had is a one-line fix.
    const result = parseDatasetPayload([{ title: 'a ticket', text: 'body' }])
    expect('error' in result && result.error).toContain('title, text')
    expect('error' in result && result.error).toContain('stable `id`')
  })

  it('says which item is at fault, not only that one is', () => {
    const result = parseDatasetPayload([
      { id: 'a', text: 'fine' },
      { id: 'b', text: 'fine' },
      { text: 'no id' },
    ])
    expect('error' in result && result.error).toContain('item 3')
  })

  it('refuses a number where a list was wanted', () => {
    const result = parseDatasetPayload(42)
    expect('error' in result && result.error).toContain('did not return a list')
  })

  it('does not invent an id from the text', () => {
    // Inventing one makes every sync duplicate the corpus, which is invisible until it is large.
    const result = parseDatasetPayload([{ text: 'body only' }])
    expect('error' in result).toBe(true)
  })
})
