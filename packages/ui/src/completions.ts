import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'

/** Asks the host for the rest of `text`; resolves to '' when there is none, it took too long, or it was superseded. */
export type Complete = (text: string) => Promise<string>

/**
 * Sends what is typed to the host and waits for its `completion` answer - the `stagedFiles` pattern: it listens only
 * while something is waiting, so it needs no wiring into the panel's message handler. Only the newest request is
 * answered; an older one resolves empty, since what it was for has already been typed over.
 */
export function completeWith(transport: Transport): Complete {
  let counter = 0
  let waiting: { id: string; resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> } | undefined
  let unsubscribe: (() => void) | undefined

  const settle = (text: string): void => {
    const current = waiting
    if (current === undefined) return
    waiting = undefined
    clearTimeout(current.timer)
    unsubscribe?.()
    unsubscribe = undefined
    current.resolve(text)
  }

  return (text) => {
    settle('')
    counter += 1
    const id = `complete-${Date.now().toString(36)}-${counter.toString(36)}`
    unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'completion' && message.id === waiting?.id) settle(message.text)
    })
    return new Promise<string>((resolve) => {
      waiting = { id, resolve, timer: setTimeout(() => settle(''), 12_000) }
      transport.post({ type: 'requestCompletion', id, text } satisfies UiToHostMessage)
    })
  }
}

/**
 * What is left of a suggestion once more has been typed: if the typing matches its start, the rest still applies (so
 * it does not flicker away while the user types what it offered); otherwise none of it does.
 */
export function remainingSuggestion(suggestedFor: string, suggestion: string, typedNow: string): string {
  if (!typedNow.startsWith(suggestedFor)) return ''
  const extra = typedNow.slice(suggestedFor.length)
  if (extra.length === 0) return suggestion
  return suggestion.startsWith(extra) ? suggestion.slice(extra.length) : ''
}
