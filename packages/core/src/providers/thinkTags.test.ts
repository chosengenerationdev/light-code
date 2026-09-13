import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ThinkTagSplitter } from './thinkTags.js'

/** Feeds text through in chunks, the way a stream delivers it. */
function stream(chunks: string[]): { text: string; reasoning: string } {
  const splitter = new ThinkTagSplitter()
  let text = ''
  let reasoning = ''
  for (const chunk of chunks) {
    const split = splitter.push(chunk)
    text += split.text
    reasoning += split.reasoning
  }
  const rest = splitter.flush()
  return { text: text + rest.text, reasoning: reasoning + rest.reasoning }
}

/**
 * Qwen3 emits its thinking inside the content unless the server was started with a reasoning
 * parser. Left alone it is shown as the answer, stored as assistant text, and re-sent on every
 * later request — and the models that do this are the ones with the least context to spare.
 */
describe('thinking that arrives inside the content', () => {
  it('separates it from the answer', () => {
    expect(stream(['<think>weighing it up</think>The answer.'])).toEqual({
      text: 'The answer.',
      reasoning: 'weighing it up',
    })
  })

  /*
   * The reason this is a state machine and not a regex. A tag split across two chunks is ordinary
   * — `<thi` then `nk>` — and a regex applied per chunk sees neither half.
   */
  it('handles a tag split across chunks', () => {
    expect(stream(['<thi', 'nk>hmm</thi', 'nk>Done.'])).toEqual({
      text: 'Done.',
      reasoning: 'hmm',
    })
  })

  it('handles thinking split across many chunks', () => {
    expect(stream(['<think>a', 'b', 'c</think>', 'Answer'])).toEqual({
      text: 'Answer',
      reasoning: 'abc',
    })
  })

  it('passes ordinary content through untouched', () => {
    const plain = 'No tags here at all, just <an angle bracket and some prose.'
    expect(stream([plain])).toEqual({ text: plain, reasoning: '' })
  })

  /*
   * A lone `<` must not stall the stream waiting to see whether it becomes `<think>`. Only as much
   * as could still be the marker is held back, and no more.
   */
  it('does not swallow prose that merely starts like a tag', () => {
    expect(stream(['a < b and c <t', 'hen d'])).toEqual({
      text: 'a < b and c <then d',
      reasoning: '',
    })
  })

  it('handles several thinking blocks in one reply', () => {
    expect(stream(['<think>one</think>A<think>two</think>B'])).toEqual({
      text: 'AB',
      reasoning: 'onetwo',
    })
  })

  /*
   * A stream cut off mid-thought leaves an unclosed tag. Emitting what there was beats dropping
   * it: losing the end of an answer to a tag that never closed is the worse failure.
   */
  it('gives back what it was holding when the stream ends', () => {
    expect(stream(['<think>cut off here'])).toEqual({
      text: '',
      reasoning: 'cut off here',
    })
    expect(stream(['answer then <thi'])).toEqual({ text: 'answer then <thi', reasoning: '' })
  })

  it('keeps content before the first tag', () => {
    expect(stream(['Sure. <think>why</think> Here it is.'])).toEqual({
      text: 'Sure.  Here it is.',
      reasoning: 'why',
    })
  })
})

describe('the wiring', () => {
  const openai = readFileSync(fileURLToPath(new URL('./openai.ts', import.meta.url)), 'utf8')

  /*
   * One splitter per stream, not one per chunk. Constructed inside the loop it would forget
   * whether it was inside a tag between chunks, which is the entire job.
   */
  it('keeps one splitter for the whole stream', () => {
    const uses = openai.match(/new ThinkTagSplitter\(\)/g) ?? []
    expect(uses).toHaveLength(1)
    const constructed = openai.indexOf('new ThinkTagSplitter()')
    const consumed = openai.indexOf('thinking.push(')
    expect(constructed).toBeLessThan(consumed)
  })

  it('routes the thinking to reasoning, not to the transcript', () => {
    expect(openai).toContain("yield { type: 'reasoning', text: split.reasoning }")
    expect(openai).toContain("yield { type: 'text', text: split.text }")
  })
})
