import { describe, expect, it } from 'vitest'

import { jsonRecords, truncateToolResult, type TruncationStore } from './truncate.js'

/**
 * Internal tools return lists of records, often far over the result cap. Paging them back with
 * read_tool_result and retyping them into `rows` costs tokens twice and is where records go missing,
 * so the notice points at `dataframe`'s `result` source, which reads the saved output by handle.
 */
function memoryStore(): TruncationStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>()
  return {
    saved,
    save: async (content) => {
      const handle = '00000000-0000-0000-0000-00000000000' + String(saved.size)
      saved.set(handle, content)
      return handle
    },
    read: async (handle) => saved.get(handle),
    deleteMany: async () => undefined,
  }
}

const big = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, desk: i % 2 === 0 ? 'rates' : 'fx', note: 'x'.repeat(30) })))

describe('records in a tool result', () => {
  it('finds a list, a wrapper, JSON Lines, and JSON after a line of text', () => {
    expect(jsonRecords('[{"a":1},{"a":2}]')).toHaveLength(2)
    expect(jsonRecords('{"total":2,"results":[{"a":1},{"a":2}]}')).toHaveLength(2)
    expect(jsonRecords('{"a":1}\n{"a":2}\n{"a":3}\n')).toHaveLength(3)
    expect(jsonRecords('Fetched 2 trades:\n[{"a":1},{"a":2}]')).toHaveLength(2)
    expect(jsonRecords('plain text, no data')).toBeUndefined()
    expect(jsonRecords('[1, 2, 3]')).toBeUndefined()
  })

  it('points a truncated payload of records at dataframe, by handle', async () => {
    const store = memoryStore()
    const result = await truncateToolResult(big, store, 8_000, { dataframe: true })
    expect(result.truncated).toBe(true)
    expect(result.content).toMatch(/It holds 500 JSON records: .*"result": "0{8}-0{4}-0{4}-0{4}-0{11}0"/)
  })

  it('says nothing about dataframe where it does not exist, or for text', async () => {
    expect((await truncateToolResult(big, memoryStore(), 8_000)).content).not.toContain('dataframe')
    expect((await truncateToolResult('word '.repeat(5000), memoryStore(), 8_000, { dataframe: true })).content).not.toContain('dataframe')
  })
})
