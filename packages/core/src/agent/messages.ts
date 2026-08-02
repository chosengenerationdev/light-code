import type { ChatMessage, ToolCall } from '../providers/types.js'

export class Conversation {
  private readonly messages: ChatMessage[] = []

  constructor(systemPrompt?: string) {
    if (systemPrompt !== undefined) {
      this.messages.push({ role: 'system', content: systemPrompt })
    }
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
