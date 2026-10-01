import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * Reactions are held by the host and delivered with the next message or at the next step. Each
 * half is a call that can quietly go missing — and a reaction that never arrives looks exactly like
 * one the model ignored — so this reads `bridge.ts` for them, the way `config/retrieval.test.ts` does.
 */
const bridge = readFileSync(new URL('./bridge.ts', import.meta.url), 'utf8')

describe('reply and reaction wiring', () => {
  it('composes the reply and pending reactions into the next message', () => {
    expect(bridge).toMatch(/handleSendMessage\(\s*composeUserText\(message\.text, \{ replyTo: boundedQuote\(message\.replyTo\), reactions: takeReactions\(\) \}\)/)
  })

  it('delivers reactions at the next step of a running turn', () => {
    const drain = bridge.slice(bridge.indexOf('drainQueuedMessages: () => {'))
    expect(drain.slice(0, 600)).toContain('takeReactions()')
  })

  it('composes a queued reply too, and forgets reactions when the conversation changes', () => {
    expect(bridge).toContain('text: composeUserText(message.text, { replyTo }),')
    expect(bridge.match(/pendingReactions\.clear\(\)/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
