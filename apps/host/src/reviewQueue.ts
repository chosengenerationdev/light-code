import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ReviewKind, ReviewRequest } from '@light-code/core'

/**
 * Python tools and skills waiting for an administrator to read them.
 *
 * ## The content is held here, not in the workspace
 *
 * A staged tool is a `.py` that must not load and a staged skill is markdown that must not reach
 * anyone's prompt. §13 already makes the *registry* the boundary rather than the approval prompt —
 * a file with no registry entry never loads — so this uses that boundary as it stands: the bytes
 * live in the queue's own directory until someone approves them, and only then are they written
 * where they can be found.
 *
 * That also means a rejected submission leaves nothing behind, and an approval writes exactly the
 * bytes the administrator read rather than whatever is on disk by then.
 */
export interface QueuedReview extends ReviewRequest {
  status: 'pending' | 'approved' | 'rejected'
  decidedBy?: string
  decidedAt?: number
  reason?: string
}

export class ReviewQueue {
  private cache: QueuedReview[] | undefined

  constructor(private readonly filePath: string) {}

  private async load(): Promise<QueuedReview[]> {
    if (this.cache !== undefined) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown
      this.cache = Array.isArray(parsed) ? (parsed as QueuedReview[]) : []
    } catch {
      this.cache = []
    }
    return this.cache
  }

  private async persist(items: QueuedReview[]): Promise<void> {
    this.cache = items
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, this.filePath)
  }

  async list(): Promise<QueuedReview[]> {
    return [...(await this.load())]
  }

  async pending(): Promise<QueuedReview[]> {
    return (await this.load()).filter((item) => item.status === 'pending')
  }

  async submit(request: Omit<ReviewRequest, 'id' | 'submittedAt'> & { kind: ReviewKind }): Promise<QueuedReview> {
    const items = await this.load()

    /*
     * One pending item per name and kind. Resubmitting replaces rather than adds: a model told its
     * work is queued sometimes tries again, and an administrator opening a queue with four
     * near-identical copies of the same tool cannot tell which one is current — they would have to
     * diff them to find out, which is the opposite of what a review queue is for.
     */
    const superseded = items.findIndex(
      (item) => item.status === 'pending' && item.kind === request.kind && item.name === request.name,
    )

    const queued: QueuedReview = {
      ...request,
      id: crypto.randomUUID(),
      submittedAt: Date.now(),
      status: 'pending',
    }

    if (superseded === -1) items.push(queued)
    else items[superseded] = queued

    await this.persist(items)
    return queued
  }

  async decide(id: string, decision: { approved: boolean; by: string; reason?: string }): Promise<QueuedReview | undefined> {
    const items = await this.load()
    const item = items.find((candidate) => candidate.id === id)
    // Not found, or already decided. Deciding twice is a stale page, not an error worth raising —
    // but it must not silently overwrite the first decision with a different one.
    if (item === undefined || item.status !== 'pending') return undefined

    item.status = decision.approved ? 'approved' : 'rejected'
    item.decidedBy = decision.by
    item.decidedAt = Date.now()
    if (decision.reason !== undefined && decision.reason.length > 0) item.reason = decision.reason

    await this.persist(items)
    return item
  }

  /**
   * Drops decided items older than the cutoff.
   *
   * Kept for a while rather than deleted on decision: "who approved this and when" is the question
   * a review queue exists to be able to answer afterwards, and the audit log records the decision
   * but not the source that was read.
   */
  async prune(olderThanMs: number): Promise<void> {
    const cutoff = Date.now() - olderThanMs
    const items = await this.load()
    const kept = items.filter((item) => item.status === 'pending' || (item.decidedAt ?? 0) > cutoff)
    if (kept.length !== items.length) await this.persist(kept)
  }
}
