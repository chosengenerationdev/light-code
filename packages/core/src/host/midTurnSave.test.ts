import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Reported: the agent crashed and "my recent investigation conversations are gone". A conversation was saved only
 * when a turn ended, and an investigation is one long turn. It is saved as it goes now - just after the user's
 * message and after each tool result. Read from the source, because the defect is a save that is never called,
 * which no test of the save itself can see.
 */
describe('saving a conversation during a turn', () => {
  const bridge = fs.readFileSync(path.join(__dirname, 'bridge.ts'), 'utf8')
  const handler = (name: string): string => {
    const at = bridge.indexOf(`${name}: (`)
    expect(at).toBeGreaterThan(0)
    return bridge.slice(at, at + 600)
  }

  it('saves before every request and after every tool result, throttled, one save at a time', () => {
    expect(handler('onContextUpdate')).toContain('persistSoon()')
    expect(handler('onToolResult')).toContain('persistSoon()')
    const soon = bridge.slice(bridge.indexOf('function persistSoon()'), bridge.indexOf('function persistSoon()') + 400)
    expect(soon).toMatch(/setTimeout\(/)
    expect(soon).toMatch(/persisting = persisting\.then\(\(\) => persistActiveTask\(\)\)/)
  })
})
