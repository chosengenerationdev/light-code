import { z } from 'zod'
import type { Tool, ToolPreview, ToolResult } from './types.js'

const paramsSchema = z.object({
  command: z.string().min(1).describe('The shell command to run.'),
  cwd: z.string().optional().describe('Working directory, relative to the workspace root. Defaults to the workspace root.'),
})
export type ExecuteCommandParams = z.infer<typeof paramsSchema>

const MAX_OUTPUT_CHARS = 200_000

/**
 * Runs via the `Terminal` platform interface, so process-tree killing on Windows
 * (`taskkill /T /F`) is handled by the host implementation — see CLAUDE.md §16.
 */
export const executeCommandTool: Tool<ExecuteCommandParams> = {
  name: 'execute_command',
  group: 'command',
  description: 'Run a shell command in the workspace and return its combined stdout/stderr and exit code.',
  parametersSchema: paramsSchema,
  async execute(params, context): Promise<ToolResult> {
    const cwd = params.cwd !== undefined ? params.cwd : context.workspaceRoot
    const proc = context.terminal.run(params.command, { cwd })

    let output = ''
    let truncated = false
    proc.onData((chunk) => {
      if (output.length < MAX_OUTPUT_CHARS) {
        output += chunk
      } else {
        truncated = true
      }
    })

    const onAbort = (): void => {
      void proc.killTree()
    }
    context.signal?.addEventListener('abort', onAbort)

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.onExit(resolve)
    })

    context.signal?.removeEventListener('abort', onAbort)

    const note = truncated ? '\n...(output truncated)' : ''
    return {
      content: `Exit code: ${exitCode}\n\n${output}${note}`,
      isError: exitCode !== 0,
    }
  },
  async preview(params, context): Promise<ToolPreview> {
    // The literal command string, unmodified — this is exactly what gets spawned.
    return { kind: 'command', command: params.command, cwd: params.cwd ?? context.workspaceRoot }
  },
}
