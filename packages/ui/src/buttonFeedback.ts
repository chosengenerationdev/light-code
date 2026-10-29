import type { Transport } from '@light-code/core/browser'

/**
 * A button that sent work to the host says so until the host answers.
 *
 * Reported from Fire Code: buttons felt like "stone" - click Save, nothing visibly happens, and a few
 * seconds later "Saved" appears. The press animation lasts a tenth of a second; the round trip to the
 * host (a config write, a connection test, a sync) can take seconds, and nothing showed in between.
 *
 * One mechanism for every button rather than a busy flag in fifty components: a click that leads to
 * a `post` in the same task marks that button `data-lc-busy` (a spinner and a progress cursor, in
 * `styles.ts`), and the mark goes when the host next says anything that is not chat streaming - every
 * handler that saves or tests answers with fresh state or a result - or after 20 seconds, whichever
 * comes first. A mark that clears early costs nothing; one that never cleared would be a lie, hence
 * the cap.
 *
 * The attribute is set on the DOM node directly. React leaves attributes it does not own alone, and a
 * button that unmounts takes its mark with it.
 */

/** Host messages that are a chat streaming, not an answer to a button. */
const STREAMING = new Set(['textChunk', 'reasoningChunk', 'toolCall', 'toolResult', 'contextUsage', 'chart', 'diagram', 'retrying'])

/** Kept short: the mark is a reassurance, not a status. */
export const BUSY_CAP_MS = 20_000

export function installButtonFeedback(transport: Transport, doc: Document = document): () => void {
  let clicked: HTMLElement | undefined
  const busy = new Set<HTMLElement>()
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

  const clear = (button: HTMLElement): void => {
    button.removeAttribute('data-lc-busy')
    busy.delete(button)
    const timer = timers.get(button)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(button)
  }

  const onClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button, [role="button"]') : null
    if (target === null) return
    clicked = target
    // Only a post made while this click is being handled counts as its work.
    setTimeout(() => {
      if (clicked === target) clicked = undefined
    }, 0)
  }
  doc.addEventListener('click', onClick, true)

  const post = transport.post.bind(transport)
  transport.post = (message: unknown): void => {
    const button = clicked
    if (button !== undefined && button.isConnected) {
      button.setAttribute('data-lc-busy', 'true')
      busy.add(button)
      const previous = timers.get(button)
      if (previous !== undefined) clearTimeout(previous)
      timers.set(button, setTimeout(() => clear(button), BUSY_CAP_MS))
    }
    post(message)
  }

  const stop = transport.onMessage((message) => {
    const type = (message as { type?: unknown } | null)?.type
    if (typeof type === 'string' && STREAMING.has(type)) return
    for (const button of [...busy]) clear(button)
  })

  return () => {
    doc.removeEventListener('click', onClick, true)
    transport.post = post
    stop()
    for (const button of [...busy]) clear(button)
  }
}
