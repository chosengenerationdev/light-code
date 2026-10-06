import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'

/** What the host made of a file the panel could not read itself. */
export type StagedResult = { name: string; path: string; text: string } | { error: string }

export type StageFile = (name: string, data: string) => Promise<StagedResult>

/**
 * Sends a file to the host to be saved and read, and waits for its `attachmentStaged` answer.
 *
 * Listens only while something is waiting, so it needs no wiring into the panel's message
 * handler. A host that never answers (closed mid-way) is given two minutes - a large PDF takes
 * seconds - and the attachment then says it failed rather than spinning for ever.
 */
export function stageFileWith(transport: Transport): StageFile {
  const waiting = new Map<string, (result: StagedResult) => void>()
  let unsubscribe: (() => void) | undefined
  let counter = 0

  const settle = (id: string, result: StagedResult): void => {
    const resolve = waiting.get(id)
    if (resolve === undefined) return
    waiting.delete(id)
    if (waiting.size === 0) {
      unsubscribe?.()
      unsubscribe = undefined
    }
    resolve(result)
  }

  return (name, data) => {
    counter += 1
    const id = `stage-${Date.now().toString(36)}-${counter.toString(36)}`
    unsubscribe ??= transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type !== 'attachmentStaged') return
      settle(
        message.id,
        message.error !== undefined || message.path === undefined
          ? { error: `${message.name}: ${message.error ?? 'could not be read.'}` }
          : { name: message.name, path: message.path, text: message.text ?? '' },
      )
    })
    return new Promise<StagedResult>((resolve) => {
      const timer = setTimeout(() => settle(id, { error: `${name}: Light Code did not answer in time.` }), 120_000)
      waiting.set(id, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      transport.post({ type: 'stageAttachment', id, name, data } satisfies UiToHostMessage)
    })
  }
}
