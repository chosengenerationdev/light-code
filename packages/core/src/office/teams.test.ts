import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { createTeamsOpenChatTool, enterScript, teamsChatLink } from './teams.js'

const NO_CONTEXT = {} as unknown as ToolExecutionContext

describe('teams_open_chat', () => {
  it('builds a Teams link with the people and the message, spaces as %20', () => {
    const built = teamsChatLink({ to: ['alice@corp.test'], message: 'PR #12 Add retry: https://git.test/pr/12' })
    expect('link' in built).toBe(true)
    if (!('link' in built)) return
    expect(built.link.startsWith('msteams:/l/chat/0/0?')).toBe(true)
    const query = new URLSearchParams(built.link.slice(built.link.indexOf('?') + 1))
    expect(query.get('users')).toBe('alice@corp.test')
    expect(query.get('message')).toBe('PR #12 Add retry: https://git.test/pr/12')
    expect(built.link).not.toContain('+')
  })

  it('names a group chat only when there is a group', () => {
    const one = teamsChatLink({ to: ['a@corp.test'], message: 'hi', topic: 'Release' })
    const two = teamsChatLink({ to: ['a@corp.test', 'b@corp.test'], message: 'hi', topic: 'Release' })
    expect('link' in one && one.link.includes('topicName')).toBe(false)
    expect('link' in two && two.link.includes('topicName=Release')).toBe(true)
  })

  it('refuses something that is not an email address, and a message too long for a link', () => {
    expect(teamsChatLink({ to: ['Alice Smith'], message: 'hi' })).toMatchObject({ problem: expect.stringContaining('Not an email') })
    expect(teamsChatLink({ to: ['a@corp.test'], message: 'x'.repeat(3000) })).toMatchObject({ problem: expect.stringContaining('too long') })
  })

  it('opens the link and says the user sends it, never that it was sent', async () => {
    const opened: string[] = []
    const tool = createTeamsOpenChatTool({ open: async (link) => void opened.push(link) })
    const result = await tool.execute({ to: ['a@corp.test'], message: 'Please review PR #12' }, NO_CONTEXT)
    expect(opened).toHaveLength(1)
    expect(result.content).toContain('do not say it was sent')
    const preview = await tool.preview?.({ to: ['a@corp.test'], message: 'Please review PR #12' }, NO_CONTEXT)
    expect(JSON.stringify(preview)).toContain('Please review PR #12')
  })

  it('presses Enter only when asked to send, and says so in the approval', async () => {
    let pressed = 0
    const tool = createTeamsOpenChatTool({ open: async () => undefined, pressEnter: async () => (pressed++, { outcome: 'sent' }) })
    await tool.execute({ to: ['a@corp.test'], message: 'hi' }, NO_CONTEXT)
    expect(pressed).toBe(0)
    const preview = await tool.preview?.({ to: ['a@corp.test'], message: 'hi', send: true }, NO_CONTEXT)
    expect(JSON.stringify(preview)).toContain('AND SEND IT')
    const sent = await tool.execute({ to: ['a@corp.test'], message: 'hi', send: true }, NO_CONTEXT)
    expect(pressed).toBe(1)
    expect(sent.content).toContain('pressed Enter')
  })

  it('tells the model that "message someone" means send, and a draft means not', () => {
    const tool = createTeamsOpenChatTool()
    expect(tool.description).toMatch(/message, send, tell, ping or inform someone, set send: true/)
    expect(tool.description).toMatch(/only when the user asked for a draft/)
  })

  it('reports NOT sent when Teams never came to the front or lost focus', async () => {
    for (const outcome of ['not-foreground', 'lost-focus', 'failed'] as const) {
      const tool = createTeamsOpenChatTool({ open: async () => undefined, pressEnter: async () => ({ outcome, detail: 'code' }) })
      const result = await tool.execute({ to: ['a@corp.test'], message: 'hi', send: true }, NO_CONTEXT)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('NOT sent')
    }
  })

  it('checks the foreground window before the key goes down, with no model text in the script', () => {
    const script = enterScript()
    const lastCheck = script.lastIndexOf('GetForegroundWindow() -ne $window')
    const keyDown = script.indexOf('keybd_event(0x0D')
    expect(lastCheck).toBeGreaterThan(0)
    expect(keyDown).toBeGreaterThan(lastCheck)
    expect([...script].every((char) => char.charCodeAt(0) < 128)).toBe(true)
    expect(enterScript({ dry: true })).toContain('$dry = $true')
  })

  it('always asks, never runs unattended, and never goes through a shell', () => {
    expect(ALWAYS_ASK_TOOLS.has('teams_open_chat')).toBe(true)
    expect(NEVER_AVAILABLE_TO_SCHEDULES.includes('teams_open_chat')).toBe(true)
    const source = readFileSync(new URL('./teams.ts', import.meta.url), 'utf8')
    // The link goes to explorer.exe as an argument; a shell would let message text become a command.
    expect(source).not.toMatch(/shell:\s*true/)
    // A blind SendKeys types into whatever has focus; the keypress here is gated on Teams being in front.
    expect(source).not.toMatch(/SendKeys/i)
  })
})
