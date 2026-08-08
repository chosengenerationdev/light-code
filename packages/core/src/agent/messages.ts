import type { ChatMessage, ToolCall } from '../providers/types.js'

export class Conversation {
  private messages: ChatMessage[] = []

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
  }

  /** Back to a fresh task, keeping the system prompt. */
  reset(): void {
    this.restore([])
  }

  isEmpty(): boolean {
    return this.messages.every((message) => message.role === 'system')
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content })
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

  toArray(): ChatMessage[] {
    return [...this.messages]
  }
}
