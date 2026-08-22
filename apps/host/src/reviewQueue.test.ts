import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeSubmission } from '@light-code/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ReviewQueue } from './reviewQueue.js'

let dir: string
let queue: ReviewQueue

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-review-'))
  queue = new ReviewQueue(path.join(dir, 'reviews.json'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const submission = (name: string, content = 'def run() -> int:\n    return 1\n') => ({
  kind: 'python-tool' as const,
  name,
  content,
  existingContent: '',
  authorId: 'entra-bob',
  authorName: 'Bob',
})

describe('submitting work for review', () => {
  it('queues it as pending, with who wrote it', async () => {
    await queue.submit(submission('parse_report'))
    const pending = await queue.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ name: 'parse_report', authorName: 'Bob', status: 'pending' })
  })

  it('keeps the exact bytes, which is what will be written on approval', async () => {
    await queue.submit(submission('x', 'def run() -> str:\n    return "exact"\n'))
    expect((await queue.pending())[0]?.content).toBe('def run() -> str:\n    return "exact"\n')
  })

  /**
   * A model told its work is queued sometimes tries again. Four near-identical copies of one tool
   * means an administrator has to diff them to find the current one, which is the opposite of what
   * a review queue is for.
   */
  it('replaces a pending item of the same name rather than adding another', async () => {
    await queue.submit(submission('parse_report', 'first'))
    await queue.submit(submission('parse_report', 'second'))
    const pending = await queue.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.content).toBe('second')
  })

  it('does not confuse a skill with a tool of the same name', async () => {
    await queue.submit(submission('shared-name'))
    await queue.submit({ ...submission('shared-name'), kind: 'skill' })
    expect(await queue.pending()).toHaveLength(2)
  })

  it('survives a restart', async () => {
    await queue.submit(submission('parse_report'))
    const reread = new ReviewQueue(path.join(dir, 'reviews.json'))
    expect(await reread.pending()).toHaveLength(1)
  })

  it('starts empty rather than failing when there is no file', async () => {
    expect(await new ReviewQueue(path.join(dir, 'absent.json')).pending()).toEqual([])
  })
})

describe('deciding', () => {
  it('records who approved it and when', async () => {
    const queued = await queue.submit(submission('parse_report'))
    const decided = await queue.decide(queued.id, { approved: true, by: 'Alice' })
    expect(decided).toMatchObject({ status: 'approved', decidedBy: 'Alice' })
    expect(decided?.decidedAt).toBeGreaterThan(0)
    expect(await queue.pending()).toHaveLength(0)
  })

  /** A rejection with no reason is one the author cannot act on. */
  it('keeps the reason for a rejection', async () => {
    const queued = await queue.submit(submission('parse_report'))
    const decided = await queue.decide(queued.id, { approved: false, by: 'Alice', reason: 'Reads outside the workspace.' })
    expect(decided).toMatchObject({ status: 'rejected', reason: 'Reads outside the workspace.' })
  })

  /** A stale page, not an error — but it must not overwrite the first decision with a different one. */
  it('refuses a second decision on the same item', async () => {
    const queued = await queue.submit(submission('parse_report'))
    await queue.decide(queued.id, { approved: true, by: 'Alice' })
    expect(await queue.decide(queued.id, { approved: false, by: 'Bob' })).toBeUndefined()
    expect((await queue.list())[0]).toMatchObject({ status: 'approved', decidedBy: 'Alice' })
  })

  it('ignores an id that does not exist', async () => {
    expect(await queue.decide('nope', { approved: true, by: 'Alice' })).toBeUndefined()
  })
})

describe('pruning', () => {
  it('keeps pending items however old, and drops decided ones past the cutoff', async () => {
    const kept = await queue.submit(submission('still-waiting'))
    const decided = await queue.submit(submission('long-decided'))
    await queue.decide(decided.id, { approved: true, by: 'Alice' })

    await queue.prune(-1) // everything decided is already older than "now plus a millisecond"
    const remaining = await queue.list()
    expect(remaining.map((item) => item.id)).toEqual([kept.id])
  })
})

describe('what the author is told', () => {
  /**
   * Phrased so the model does not treat it as a failure and retry — a retry adds nothing but work
   * for whoever reads the queue — and so it does not then try to call a tool that cannot run.
   */
  it('says it is not callable and that retrying is pointless', () => {
    const message = describeSubmission({ kind: 'python-tool', name: 'parse_report' })
    expect(message).toContain('not callable yet')
    expect(message).toContain('nothing to retry')
    expect(message).toContain('parse_report')
  })

  it('calls a skill a skill', () => {
    expect(describeSubmission({ kind: 'skill', name: 'release-process' })).toContain('skill')
  })
})
