import { describe, expect, it } from 'vitest'
import type { HttpClient, WebSocketConnection } from '@light-code/core'
import { withHeadersDeadline } from './httpDeadline.js'

/**
 * Reported from Fire Code: `hub_run` always failed with "This host cannot open the WebSocket a kernel
 * needs", while every other hub call worked. The deadline wrapper rebuilt the client with `request`
 * alone, so the WebSocket a kernel speaks over was dropped on the way.
 */
describe('the headers deadline', () => {
  it('keeps the WebSocket the client had', () => {
    const socket = {} as WebSocketConnection
    let asked: string | undefined
    const inner: HttpClient = {
      request: () => Promise.reject(new Error('unused')),
      openWebSocket(url) {
        asked = url
        return socket
      },
    }
    const wrapped = withHeadersDeadline(inner)
    expect(wrapped.openWebSocket?.('wss://hub/api/kernels/1/channels')).toBe(socket)
    expect(asked).toBe('wss://hub/api/kernels/1/channels')
  })

  it('does not invent one the client lacks', () => {
    expect(withHeadersDeadline({ request: () => Promise.reject(new Error('unused')) }).openWebSocket).toBeUndefined()
  })
})
