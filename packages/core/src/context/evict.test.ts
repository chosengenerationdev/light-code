import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../providers/types.js'
import { createForgetDocsTool } from '../tools/forgetDocs.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { dropEvictedDocs, EVICTED_MARKER, FORGET_DOCS_TOOL } from './evict.js'

const SCHEMA = 'x'.repeat(400)

function docsCall(id: string, query: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: 'search_docs', arguments: JSON.stringify({ query }) }],
  }
}

function result(id: string, content: string): ChatMessage {
  return { role: 'tool', toolCallId: id, content }
}

function forget(id = 'forget_1'): ChatMessage {
  return { role: 'assistant', content: '', toolCalls: [{ id, name: FORGET_DOCS_TOOL, arguments: '{}' }] }
}

describe('dropEvictedDocs', () => {
  it('does nothing until the model asks', () => {
    const messages = [docsCall('a', 'upload'), result('a', SCHEMA)]
    const evicted = dropEvictedDocs(messages)

    expect(evicted.evictedCount).toBe(0)
    expect(evicted.messages).toEqual(messages)
  })

  it('replaces documentation the model finished with', () => {
    const evicted = dropEvictedDocs([
      docsCall('a', 'upload'),
      result('a', SCHEMA),
      forget(),
      result('forget_1', 'Released.'),
    ])

    expect(evicted.evictedCount).toBe(1)
    expect(evicted.charactersSaved).toBeGreaterThan(300)
    expect(evicted.messages[1]).toEqual({ role: 'tool', toolCallId: 'a', content: EVICTED_MARKER })
  })

  /**
   * The rule that stops this being actively harmful. A schema looked up *after* the release
   * is one the model is about to use; dropping it would turn a context saving into a failed
   * tool call with arguments invented from memory.
   */
  it('never touches documentation retrieved after the release', () => {
    const evicted = dropEvictedDocs([
      docsCall('old', 'upload'),
      result('old', SCHEMA),
      forget(),
      result('forget_1', 'Released.'),
      docsCall('new', 'download'),
      result('new', SCHEMA),
    ])

    expect(evicted.evictedCount).toBe(1)
    expect(evicted.messages[1]?.content).toBe(EVICTED_MARKER)
    expect(evicted.messages[5]?.content).toBe(SCHEMA)
  })

  /** A second release means a further batch is finished; honouring only the first strands it. */
  it('honours the most recent release, not the first', () => {
    const evicted = dropEvictedDocs([
      docsCall('a', 'one'),
      result('a', SCHEMA),
      forget('f1'),
      result('f1', 'Released.'),
      docsCall('b', 'two'),
      result('b', SCHEMA),
      forget('f2'),
      result('f2', 'Released.'),
    ])

    expect(evicted.evictedCount).toBe(2)
  })

  /**
   * Deleting the message would leave an unanswered `tool_use`, which every provider rejects.
   * The count of messages, and their ids, must be identical.
   */
  it('replaces rather than removes, so no tool call is orphaned', () => {
    const messages = [docsCall('a', 'upload'), result('a', SCHEMA), forget(), result('forget_1', 'Released.')]
    const evicted = dropEvictedDocs(messages)

    expect(evicted.messages).toHaveLength(messages.length)
    expect(evicted.messages.map((message) => (message.role === 'tool' ? message.toolCallId : message.role))).toEqual(
      messages.map((message) => (message.role === 'tool' ? message.toolCallId : message.role)),
    )
  })

  /** File reads and command output are not documentation, and releasing them would lose work. */
  it('leaves every other kind of tool result alone', () => {
    const evicted = dropEvictedDocs([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'r', name: 'read_file', arguments: '{"path":"a.ts"}' },
          { id: 'c', name: 'execute_command', arguments: '{"command":"npm test"}' },
        ],
      },
      result('r', SCHEMA),
      result('c', SCHEMA),
      forget(),
      result('forget_1', 'Released.'),
    ])

    expect(evicted.evictedCount).toBe(0)
    expect(evicted.messages[1]?.content).toBe(SCHEMA)
    expect(evicted.messages[2]?.content).toBe(SCHEMA)
  })

  it('skips a result already shorter than the marker', () => {
    const evicted = dropEvictedDocs([docsCall('a', 'x'), result('a', 'none'), forget(), result('forget_1', 'ok')])
    expect(evicted.evictedCount).toBe(0)
    expect(evicted.messages[1]?.content).toBe('none')
  })

  /** Runs on every request, so a second pass must not double-count or re-replace. */
  it('is idempotent', () => {
    const once = dropEvictedDocs([docsCall('a', 'x'), result('a', SCHEMA), forget(), result('forget_1', 'Released.')])
    const twice = dropEvictedDocs(once.messages)

    expect(twice.evictedCount).toBe(0)
    expect(twice.messages).toEqual(once.messages)
  })
})

describe('forget_docs', () => {
  const context = {} as unknown as ToolExecutionContext

  /** A control tool: it performs no work on the workspace, so there is nothing to approve. */
  it('is in the always group', () => {
    expect(createForgetDocsTool().group).toBe('always')
  })

  /**
   * The eviction happens when the *next* request is assembled, so a result claiming an
   * immediate effect would be contradicted by the model still seeing the schemas — and it
   * would reasonably call this again.
   */
  it('says the release takes effect next message rather than now', async () => {
    const result = await createForgetDocsTool().execute({}, context)
    expect(result.isError).toBeUndefined()
    expect(result.content).toMatch(/next message/i)
    expect(result.content).toMatch(/search_docs/)
  })
})
