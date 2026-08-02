import type { z } from 'zod'
import type { PathDenylist } from '../fs/denylist.js'
import type { FileSystem } from '../platform/filesystem.js'
import type { Terminal } from '../platform/terminal.js'

export type ToolGroup = 'read' | 'edit' | 'command' | 'mcp' | 'always'

export interface ToolResult {
  content: string
  isError?: boolean
  /** Present for tools that touch a specific file, so the loop can track consecutive mistakes per file. */
  path?: string
}

export interface ToolExecutionContext {
  fs: FileSystem
  terminal: Terminal
  workspaceRoot: string
  denylist: PathDenylist
  /**
   * Confined, normalized paths read via `read_file` this session. `write_to_file`/
   * `apply_diff` refuse to touch an *existing* file that isn't in this set — cheap
   * invariant, eliminates a class of hallucinated edits. See CLAUDE.md §6.
   */
  readFiles: Set<string>
  signal?: AbortSignal
}

export interface Tool<TParams = Record<string, unknown>> {
  name: string
  group: ToolGroup
  description: string
  parametersSchema: z.ZodType<TParams>
  execute(params: TParams, context: ToolExecutionContext): Promise<ToolResult>
}
