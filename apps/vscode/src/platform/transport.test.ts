import { describe, expect, it, vi } from 'vitest'

import { WebviewTransport } from './transport.js'

interface FakeWebview {
  postMessage: (message: unknown) => Promise<boolean>
  onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose: () => void }
  emit: (message: unknown) => void
  posted: unknown[]
  disposed: boolean
}

function fakeWebview(): FakeWebview {
  const listeners = new Set<(message: unknown) => void>()
  const webview: FakeWebview = {
    posted: [],
    disposed: false,
    postMessage: (message) => {
      webview.posted.push(message)
      return Promise.resolve(true)
    },
    onDidReceiveMessage: (listener) => {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
          webview.disposed = true
        },
      }
    },
    emit: (message) => {
      for (const listener of listeners) listener(message)
    },
  }
  return webview
}

/**
 * The bridge now outlives the view, so these are the properties that let it: a swapped
 * webview must not deafen it, and a missing one must not break it.
 */
describe('WebviewTransport', () => {
  it('keeps delivering to the bridge after the view is rebuilt', () => {
    const transport = new WebviewTransport()
    const received: unknown[] = []
    transport.onMessage((message) => received.push(message))

    const first = fakeWebview()
    transport.attach(first as never)
    first.emit({ type: 'a' })

    // What used to break: the bridge subscribed to the *old* webview, so every control in
    // the reopened panel was inert.
    const second = fakeWebview()
    transport.attach(second as never)
    second.emit({ type: 'b' })

    expect(received).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('stops listening to a webview it has moved on from', () => {
    const transport = new WebviewTransport()
    const received: unknown[] = []
    transport.onMessage((message) => received.push(message))

    const first = fakeWebview()
    transport.attach(first as never)
    transport.attach(fakeWebview() as never)
    first.emit({ type: 'stale' })

    expect(received).toEqual([])
  })

  it('drops posts when nothing is attached, rather than throwing', () => {
    const transport = new WebviewTransport()
    // A scheduled run with the panel closed posts progress to nobody. That is not an error:
    // its output is persisted to the task store either way.
    expect(() => transport.post({ type: 'textChunk' })).not.toThrow()

    const webview = fakeWebview()
    transport.attach(webview as never)
    transport.post({ type: 'after' })
    transport.detach()
    transport.post({ type: 'gone' })

    expect(webview.posted).toEqual([{ type: 'after' }])
  })

  it('routes to the newest view only', async () => {
    const transport = new WebviewTransport()
    const first = fakeWebview()
    const second = fakeWebview()
    transport.attach(first as never)
    transport.attach(second as never)
    transport.post({ type: 'x' })
    await vi.waitFor(() => expect(second.posted).toHaveLength(1))

    expect(first.posted).toEqual([])
  })
})
