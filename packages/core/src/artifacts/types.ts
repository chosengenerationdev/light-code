/**
 * The shapes the Files panel and the host exchange (`artifacts.ts` builds them). Here, with no Node
 * imports, so the panel can use them through `@light-code/core/browser`.
 */

export type ArtifactKind = 'document' | 'spreadsheet' | 'presentation' | 'image' | 'data' | 'code' | 'archive' | 'email' | 'text' | 'other'

export interface AgentWrite {
  tool: string
  /** The reason the agent gave with the call (`why`), when it gave one. */
  why?: string
}

export interface ArtifactEntry {
  /** Relative to the workspace, with `/` separators. */
  path: string
  name: string
  kind: ArtifactKind
  size: number
  /** Milliseconds since the epoch. */
  modified: number
  created: number
  /** Modified at or after the chat started. */
  changedThisChat: boolean
  /** Created at or after the chat started. */
  newThisChat: boolean
  /** The tool calls in this chat that wrote it, oldest first. */
  writes?: AgentWrite[]
  /** One line about what is in it, when that can be told cheaply. */
  summary?: string
}

export interface ArtifactList {
  root: string
  since: number
  files: ArtifactEntry[]
  /** How many files the walk saw, before the newest were kept. */
  scanned: number
  /** The walk stopped at its cap: the folder has more files than were looked at. */
  truncated: boolean
}

export interface ArtifactInfo {
  path: string
  kind: ArtifactKind
  size: number
  modified: number
  created: number
  /** Facts, e.g. "120 lines", "3 sheets: Summary, Data, Notes", "12 pages". */
  facts: string[]
  /** The start of its content as text, when it has any. */
  preview?: string
  writes?: AgentWrite[]
}
