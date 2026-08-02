import { applyDiffTool } from './applyDiff/index.js'
import { askFollowupQuestionTool } from './askFollowupQuestion.js'
import { attemptCompletionTool } from './attemptCompletion.js'
import { executeCommandTool } from './executeCommand.js'
import { listFilesTool } from './listFiles.js'
import { readFileTool } from './readFile.js'
import { ToolRegistry } from './registry.js'
import { searchFilesTool } from './searchFiles.js'
import { writeToFileTool } from './writeToFile.js'

export * from './types.js'
export { ToolRegistry } from './registry.js'
export { readFileTool } from './readFile.js'
export { listFilesTool } from './listFiles.js'
export { searchFilesTool } from './searchFiles.js'
export { writeToFileTool } from './writeToFile.js'
export { applyDiffTool } from './applyDiff/index.js'
export { executeCommandTool } from './executeCommand.js'
export { askFollowupQuestionTool } from './askFollowupQuestion.js'
export { attemptCompletionTool } from './attemptCompletion.js'
export { createReadToolResultTool } from './readToolResult.js'

/**
 * The eight tools that don't require MCP (use_mcp_tool is Phase 5's job — there are no
 * MCP servers to call yet). See CLAUDE.md §6.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(listFilesTool)
  registry.register(searchFilesTool)
  registry.register(writeToFileTool)
  registry.register(applyDiffTool)
  registry.register(executeCommandTool)
  registry.register(askFollowupQuestionTool)
  registry.register(attemptCompletionTool)
  return registry
}
