import { describe, expect, it } from 'vitest'
import { AppInbox } from './appInbox.js'

/*
 * Fire Code's "Start a chat" from a monitoring alert opened an empty chat: the alert's text arrived while the new
 * chat was still connecting, before the app was listening. Reported twice.
 */
function fakeTransport(listeners: number): { listenerCount: () => number; redeliver: (m: unknown) => void; delivered: unknown[]; add: () => void } {
  let count = listeners
  const delivered: unknown[] = []
  return { listenerCount: () => count, redeliver: (m) => delivered.push(m), delivered, add: () => (count += 1) }
}

describe('what arrives for the chat app before it listens', () => {
  it('is held while the page connects, and handed over once the app subscribes', () => {
    const transport = fakeTransport(1)
    const steps: (() => void)[] = []
    const inbox = new AppInbox(transport, (then) => steps.push(then))
    inbox.deliver({ type: 'prefillComposer', text: 'Help me investigate this monitoring alert' })
    expect(transport.delivered).toEqual([])

    inbox.openWhenListening()
    steps.shift()?.()
    expect(transport.delivered).toEqual([])

    transport.add() // the app's own listener
    steps.shift()?.()
    expect(transport.delivered).toEqual([{ type: 'prefillComposer', text: 'Help me investigate this monitoring alert' }])
  })

  it('is passed straight on once the app is listening', () => {
    const transport = fakeTransport(1)
    const steps: (() => void)[] = []
    const inbox = new AppInbox(transport, (then) => steps.push(then))
    inbox.openWhenListening()
    transport.add()
    steps.shift()?.()
    inbox.deliver({ type: 'prefillComposer', text: 'later' })
    expect(transport.delivered).toEqual([{ type: 'prefillComposer', text: 'later' }])
  })
})
