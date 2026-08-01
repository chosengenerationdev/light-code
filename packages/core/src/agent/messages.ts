import type { ChatMessage } from '../providers/types.js'

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

  addAssistantMessage(content: string): void {
    this.messages.push({ role: 'assistant', content })
  }

  toArray(): ChatMessage[] {
    return [...this.messages]
  }
}
