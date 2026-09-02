import { describe, expect, it } from 'vitest'

import { createRecallExpertTool, type ExpertConsultationRecord } from './recallExpert.js'
import type { ToolExecutionContext } from './types.js'

/**
 * Requested as "when there is an error after getting expert advice, expert advice should be kept
 * safe to avoid another consultation wasting".
 *
 * Advice is the expensive thing in Junior mode and easy to lose — a failed tool call, a
 * cancelled turn, a compacted history. The obvious recovery is to ask again, and that is the
 * one recovery that costs money for an answer already bought.
 */
const context = {} as unknown as ToolExecutionContext

const record = (question: string, advice: string): ExpertConsultationRecord => ({ at: 0, question, advice })

const run = async (history: ExpertConsultationRecord[], contains?: string): Promise<string> => {
  const tool = createRecallExpertTool({ history: () => history })
  const result = await tool.execute(contains === undefined ? {} : { contains }, context)
  return result.content
}

describe('recalling what the expert already said', () => {
  it('returns previous advice verbatim, with the question it answered', async () => {
    const content = await run([record('how do I wire the cache?', 'Put it behind the resolver.')])
    expect(content).toContain('how do I wire the cache?')
    expect(content).toContain('Put it behind the resolver.')
  })

  it('can be narrowed to the consultation that matters', async () => {
    const content = await run(
      [record('about caching', 'Cache advice.'), record('about routing', 'Routing advice.')],
      'routing',
    )
    expect(content).toContain('Routing advice.')
    expect(content).not.toContain('Cache advice.')
  })

  /**
   * "Nothing matched" and "nothing was ever said" have to read differently, or a filter that
   * missed sends the model straight back to paying for a fresh consultation.
   */
  it('says how many exist when a filter matches none of them', async () => {
    const content = await run([record('about caching', 'Cache advice.')], 'deployment')
    expect(content).toContain('1 consultation')
    expect(content).toContain('without a filter')
  })

  it('says plainly when the expert has not been asked anything yet', async () => {
    const content = await run([])
    expect(content).toContain('not been consulted')
    expect(content).toContain('ask_expert')
  })

  /** It must be safe to tell the model to reach for this first, so it can never spend. */
  it('is a read tool with no way to reach the CLI', () => {
    const tool = createRecallExpertTool({ history: () => [] })
    expect(tool.group).toBe('read')
    expect(JSON.stringify(tool)).not.toContain('consultExpert')
  })
})
