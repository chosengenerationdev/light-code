import type { ChatMessage } from '../providers/types.js'

/**
 * A persisted conversation.
 *
 * **`messages` is the model-facing `ChatMessage[]`, and it is the only stored
 * representation.** What the UI renders is derived from it (see `transcript.ts`) rather
 * than saved alongside it — two stored views of the same conversation would drift, and
 * §15's single-schema rule exists for exactly that reason.
 */
export interface Task {
  id: string
  /** Tasks are listed per workspace, so another project's work never appears here. */
  workspaceRoot: string
  /** Derived from the first user message; see `titles.ts`. */
  title: string
  /** Epoch ms. */
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /**
   * Handles of tool results spilled to disk by `agent/truncate.ts`. The transcript
   * references them rather than duplicating the content, so deleting a task has to delete
   * these too or the spill directory grows without bound.
   */
  resultHandles: string[]
}

/** Enough to render the history list without loading every transcript. */
export interface TaskSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export function taskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    // The system prompt is not part of what the user said or saw.
    messageCount: task.messages.filter((message) => message.role !== 'system').length,
  }
}

/**
 * Core owns the format and this interface; the host supplies the path — the same split as
 * `ConfigStore` (§15), so the Node host later reuses the format unchanged.
 */
export interface TaskStore {
  /** Newest first. */
  list(workspaceRoot: string): Promise<TaskSummary[]>
  load(id: string): Promise<Task | undefined>
  save(task: Task): Promise<void>
  /** Also removes the task's spilled tool results. */
  delete(id: string): Promise<void>
}
