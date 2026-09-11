import { describe, expect, it } from 'vitest'

import { createCheckCollectorTool } from '../tools/checkCollectorTool.js'

/**
 * Diagnosing a Python tool that was meant to feed a dataset.
 *
 * Reported: asked for a collector, the assistant wrote an ordinary Python tool returning something
 * a person would read, and the mismatch surfaced only when a sync ran — attributed to the dataset
 * rather than to the tool. Two answers: a creation path that checks, and this, which works on the
 * tools that already exist and were written before either.
 */
function tool(run: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  return createCheckCollectorTool({ run, has: (name) => name.startsWith('py__') })
}

async function check(run: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const result = await tool(run).execute({ name: 'tickets' } as never, {} as never)
  return { text: String(result.content), failed: result.isError === true }
}

describe('checking a collector', () => {
  it('passes a tool that returns records', async () => {
    const { text, failed } = await check(async () => [{ id: 'T-1', text: 'disk full', timestamp: Date.now() }])
    expect(failed).toBe(false)
    expect(text).toContain('Usable')
  })

  it('names what a report-shaped return actually was', async () => {
    /*
     * The reported failure. Telling somebody "not a usable record" without saying what arrived
     * leaves them guessing; saying "a string of 61 characters, starting ..." does not.
     */
    const { text, failed } = await check(async () => 'Here are the 5 most recent tickets:\n- TICKET-1 disk full')
    expect(failed).toBe(true)
    expect(text).toContain('a string of')
    expect(text).toContain('Here are the 5 most recent')
  })

  it('shows the shape it should have returned', async () => {
    const { text } = await check(async () => [{ summary: 'no id here' }])
    expect(text).toContain('"id"')
    expect(text).toContain('"text"')
    expect(text).toContain('stable across runs')
  })

  it('says which keys the item did have', async () => {
    const { text } = await check(async () => [{ summary: 'a', status: 'open' }])
    expect(text).toContain('summary, status')
  })

  it('treats an empty result as valid but unverified', async () => {
    // `[]` is a successful sync. Calling it a failure would push people to fabricate data.
    const { text, failed } = await check(async () => [])
    expect(failed).toBe(false)
    expect(text).toContain('no records')
  })

  it('warns when records have no timestamp', async () => {
    // They can never be aged out by retention and never appear in a withinDays search.
    const { text } = await check(async () => [{ id: 'a', text: 'x' }])
    expect(text).toContain('no timestamp')
  })

  it('separates "cannot run" from "wrong shape"', async () => {
    const { text, failed } = await check(async () => {
      throw new Error('connection refused')
    })
    expect(failed).toBe(true)
    expect(text).toContain('could not be run')
    // Different advice: fix the tool or the network, not the record shape.
    expect(text).not.toContain('"id"')
  })

  it('says so when there is no such tool', async () => {
    const result = await createCheckCollectorTool({ run: async () => [], has: () => false }).execute(
      { name: 'missing' } as never,
      {} as never,
    )
    expect(String(result.content)).toContain('no Python tool called "missing"')
  })

  it('accepts the name with or without the py__ prefix', async () => {
    const asked: string[] = []
    const instance = createCheckCollectorTool({
      run: async (name) => {
        asked.push(name)
        return [{ id: 'a', text: 'x' }]
      },
      has: (name) => name === 'py__tickets',
    })
    await instance.execute({ name: 'tickets' } as never, {} as never)
    await instance.execute({ name: 'py__tickets' } as never, {} as never)
    expect(asked).toEqual(['py__tickets', 'py__tickets'])
  })
})
