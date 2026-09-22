import { createShowChartTool } from './showChart.js'
import { createShowDiagramTool } from './showDiagram.js'
import { applyDiffTool } from './applyDiff/index.js'
import { askFollowupQuestionTool } from './askFollowupQuestion.js'
import { createAskUserFormTool } from './askUserForm.js'
import { attemptCompletionTool } from './attemptCompletion.js'
import { executeCommandTool } from './executeCommand.js'
import { createLightCodeHelpTool } from './help.js'
import { listFilesTool } from './listFiles.js'
import { readFileTool } from './readFile.js'
import { readDocumentTool } from './readDocument.js'
import { ToolRegistry } from './registry.js'
import { searchFilesTool } from './searchFiles.js'
import { writeToFileTool } from './writeToFile.js'

export * from './types.js'
export { ToolRegistry } from './registry.js'
export { readFileTool } from './readFile.js'
export { readDocumentTool, type ReadDocumentParams } from './readDocument.js'
export { listFilesTool } from './listFiles.js'
export { searchFilesTool } from './searchFiles.js'
export { writeToFileTool } from './writeToFile.js'
export { applyDiffTool } from './applyDiff/index.js'
export { executeCommandTool } from './executeCommand.js'
export { askFollowupQuestionTool } from './askFollowupQuestion.js'
export {
  createRecallExpertTool,
  type ExpertConsultationRecord,
} from './recallExpert.js'
export {
  coerceFormValue,
  createAskUserFormTool,
  formFieldSchema,
  type AskUserFormParams,
  type FormAnswer,
  type FormField,
  type FormValue,
} from './askUserForm.js'
export { attemptCompletionTool } from './attemptCompletion.js'
export { createReadToolResultTool } from './readToolResult.js'
export { createLightCodeHelpTool, type LightCodeHelpParams } from './help.js'

/**
 * The eight tools that don't require MCP (use_mcp_tool is Phase 5's job — there are no
 * MCP servers to call yet). See CLAUDE.md §6.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(readDocumentTool)
  registry.register(listFilesTool)
  registry.register(searchFilesTool)
  registry.register(writeToFileTool)
  registry.register(applyDiffTool)
  registry.register(executeCommandTool)
  registry.register(askFollowupQuestionTool)
  registry.register(createAskUserFormTool())
  registry.register(createShowChartTool())
  registry.register(createShowDiagramTool())
  /*
   * Light Code's own documentation, so it can answer questions about itself.
   *
   * A built-in rather than something registered conditionally, because there is nothing to
   * configure: it reads a constant in the bundle and touches neither disk nor network. See
   * `tools/help.ts` for why it stays advertised when the dispatcher hides most things.
   */
  registry.register(createLightCodeHelpTool())
  registry.register(attemptCompletionTool)
  return registry
}
