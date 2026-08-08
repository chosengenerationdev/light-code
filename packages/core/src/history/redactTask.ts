import { redact } from '../logging/redact.js'
import type { ChatMessage } from '../providers/types.js'
import type { Task } from './types.js'

/**
 * Everything written to disk goes through `redact()` — CLAUDE.md §15.
 *
 * This matters more for history than for logs. Tool output routinely echoes secrets: a
 * command that prints an environment variable, a config file read back, a curl invocation
 * with a header. In a live session that is transient; persisted, it becomes a secret
 * sitting in a plaintext JSON file under the user's profile directory, surviving long
 * after the session that produced it.
 *
 * Applied at the storage boundary rather than at capture time so the model still sees real
 * tool output during the session it belongs to. The consequence — accepted deliberately —
 * is that resuming a task feeds the model the redacted text, not the original. Losing a
 * value the model should not have been shown twice is the better failure.
 */
export function redactMessage(message: ChatMessage, knownSecrets: readonly string[]): ChatMessage {
  if (message.role === 'assistant') {
    const redacted: ChatMessage = { role: 'assistant', content: redact(message.content, knownSecrets) }
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      redacted.toolCalls = message.toolCalls.map((call) => ({
        ...call,
        // Arguments are model-authored, but a model can echo a secret it was shown.
        arguments: redact(call.arguments, knownSecrets),
      }))
    }
    return redacted
  }
  if (message.role === 'tool') {
    return { role: 'tool', toolCallId: message.toolCallId, content: redact(message.content, knownSecrets) }
  }
  return { role: message.role, content: redact(message.content, knownSecrets) }
}

export function redactTask(task: Task, knownSecrets: readonly string[]): Task {
  return {
    ...task,
    title: redact(task.title, knownSecrets),
    messages: task.messages.map((message) => redactMessage(message, knownSecrets)),
  }
}
