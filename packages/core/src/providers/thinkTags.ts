/**
 * Thinking that arrives inside the content, as `<think>…</think>`.
 *
 * ## Why this is needed at all
 *
 * DeepSeek puts a reasoning trace in `reasoning_content`, and several gateways use `reasoning`;
 * both are handled and neither is a problem, because a separate field is easy to route separately.
 * **Qwen3 does not**, unless whoever serves it configured a reasoning parser — vLLM and SGLang
 * need `--reasoning-parser` switched on explicitly. Without it the model's thinking arrives in
 * `content`, wrapped in `<think>` tags, and there is no field to tell it apart from the answer.
 *
 * Untouched it costs three things, and the third is the expensive one:
 *
 * 1. It is shown to the user as the reply.
 * 2. It is stored in the conversation as assistant text.
 * 3. It is therefore **re-sent on every subsequent request**, for the rest of the task. A model
 *    with 32k of context spends a growing share of it re-reading its own discarded reasoning —
 *    and the models that emit these tags are exactly the ones with the least room to spare.
 *
 * ## Why a state machine rather than a regex
 *
 * The text arrives in stream chunks, and a tag is routinely split across two of them — `<thi` then
 * `nk>`. A regex over each chunk sees neither. So this holds the partial tag and decides once it
 * can, which is also why it has to be a per-stream object rather than a pure function.
 *
 * ## What it does not do
 *
 * It does not discard the thinking: it is emitted as `reasoning`, the same channel the separate
 * fields use, so it renders as a trace and stays out of history. And it only acts when a tag is
 * actually present — a model that never emits one is passed through byte for byte.
 */

const OPEN = '<think>'
const CLOSE = '</think>'

export interface ThinkSplit {
  /** The answer, with any thinking removed. */
  text: string
  /** The thinking, for the reasoning channel. */
  reasoning: string
}

/**
 * Splits a stream of content chunks into answer and thinking.
 *
 * Stateful across calls, because the tags do not respect chunk boundaries.
 */
export class ThinkTagSplitter {
  private inside = false
  /** A partial tag held back until the next chunk says what it is. */
  private pending = ''

  push(chunk: string): ThinkSplit {
    let text = ''
    let reasoning = ''
    let buffer = this.pending + chunk
    this.pending = ''

    for (;;) {
      const marker = this.inside ? CLOSE : OPEN
      const at = buffer.indexOf(marker)

      if (at !== -1) {
        const before = buffer.slice(0, at)
        if (this.inside) reasoning += before
        else text += before
        this.inside = !this.inside
        buffer = buffer.slice(at + marker.length)
        continue
      }

      /*
       * No complete marker. The tail might still be the start of one, so hold back just enough to
       * find out — never more, or a model that emits `<` in ordinary prose would stall.
       */
      const keep = partialMarkerLength(buffer, marker)
      const usable = buffer.slice(0, buffer.length - keep)
      this.pending = buffer.slice(buffer.length - keep)
      if (this.inside) reasoning += usable
      else text += usable
      break
    }

    return { text, reasoning }
  }

  /**
   * Whatever is still held back when the stream ends.
   *
   * A truncated stream can leave a partial tag, or an unclosed `<think>`. Emitting the remainder
   * rather than dropping it means a cut-off reply still shows what there was — losing the end of
   * an answer to a tag that never closed would be a worse failure than showing a stray `<`.
   */
  flush(): ThinkSplit {
    const rest = this.pending
    this.pending = ''
    return this.inside ? { text: '', reasoning: rest } : { text: rest, reasoning: '' }
  }
}

/** How many trailing characters could still become `marker`. */
function partialMarkerLength(buffer: string, marker: string): number {
  const most = Math.min(marker.length - 1, buffer.length)
  for (let length = most; length > 0; length -= 1) {
    if (marker.startsWith(buffer.slice(buffer.length - length))) return length
  }
  return 0
}
