import type { ChatMessage, ImageAttachment, ToolCall } from '../providers/types.js'

export class Conversation {
  private messages: ChatMessage[] = []
  /**
   * Set once history has been compacted. The summary replaces the first `replacedCount`
   * non-system messages **in what is sent to the model only** — `messages` keeps the
   * originals.
   */
  private compaction: { summary: ChatMessage; replacedCount: number } | undefined

  constructor(systemPrompt?: string) {
    if (systemPrompt !== undefined) {
      this.messages.push({ role: 'system', content: systemPrompt })
    }
  }

  /**
   * Replaces the history with a stored transcript, keeping the *current* system prompt
   * rather than the one saved with the task. The prompt encodes the workspace root, the
   * available tools, and the current mode — all of which may have changed since the task
   * was written, and a stale prompt would describe a world that no longer exists.
   */
  restore(messages: readonly ChatMessage[]): void {
    const systemPrompt = this.messages.find((message) => message.role === 'system')
    const restored = messages.filter((message) => message.role !== 'system')
    this.messages = systemPrompt !== undefined ? [systemPrompt, ...restored] : [...restored]
    // A stored transcript is the full record, so it starts uncompacted. Compaction will
    // re-trigger on the next turn if the restored history is still over the threshold.
    this.compaction = undefined
  }

  /** Back to a fresh task, keeping the system prompt. */
  reset(): void {
    this.restore([])
  }

  isEmpty(): boolean {
    return this.messages.every((message) => message.role === 'system')
  }

  /**
   * Replaces the system prompt, keeping the rest of the history.
   *
   * Only call this at a session boundary — a profile or mode switch. The prompt sits at the
   * front of every request, so changing it invalidates the cache prefix and everything
   * after it (§12). A switch already breaks that prefix, so doing it there costs nothing;
   * doing it per turn would be expensive and invisible.
   */
  setSystemPrompt(prompt: string): void {
    const existing = this.messages.findIndex((message) => message.role === 'system')
    if (existing === -1) this.messages.unshift({ role: 'system', content: prompt })
    else this.messages[existing] = { role: 'system', content: prompt }
  }

  /** The current system prompt, so a caller can tell whether it needs replacing. */
  systemPrompt(): string | undefined {
    return this.messages.find((message) => message.role === 'system')?.content
  }

  addUserMessage(content: string, images?: ImageAttachment[]): void {
    this.messages.push(images !== undefined && images.length > 0 ? { role: 'user', content, images } : { role: 'user', content })
  }

  addAssistantMessage(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push(
      toolCalls !== undefined && toolCalls.length > 0
        ? { role: 'assistant', content, toolCalls }
        : { role: 'assistant', content },
    )
  }

  addToolResultMessage(toolCallId: string, content: string): void {
    this.messages.push({ role: 'tool', toolCallId, content })
  }

  /**
   * The complete record of what happened. This is what gets persisted and rendered —
   * compaction must never destroy stored history, so the user can still read what actually
   * happened after the model's view of it has been summarised.
   */
  toArray(): ChatMessage[] {
    return [...this.messages]
  }

  /**
   * What is actually sent to the model: the same history with any compaction applied.
   *
   * Keeping these two separate is the whole point. Compacting `messages` in place would
   * save the same tokens, but the transcript on disk would then be a summary of the
   * session rather than the session.
   */
  toModelMessages(): ChatMessage[] {
    const compaction = this.compaction
    if (compaction === undefined) return [...this.messages]

    const system = this.messages.filter((message) => message.role === 'system')
    const rest = this.messages.filter((message) => message.role !== 'system')
    return [...system, compaction.summary, ...rest.slice(compaction.replacedCount)]
  }

  /**
   * Records that the oldest `replacedCount` non-system messages are now represented by
   * `summary` in what is sent. Replaces any previous compaction rather than stacking, so
   * the count is always measured against the full history.
   */
  applyCompaction(summary: ChatMessage, replacedCount: number): void {
    this.compaction = { summary, replacedCount }
  }

  /** How many messages the model no longer sees verbatim. */
  compactedCount(): number {
    return this.compaction?.replacedCount ?? 0
  }
}
