import { z } from 'zod'
import { isSafeCommand } from '../approval/safeCommands.js'
import { staleFilesNamedIn } from './readStamps.js'
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
    /*
     * A command that names a file which changed after this chat read it - another chat, the user,
     * another program - waits until the file is read again, exactly as the edit tools do. Reading
     * commands (type, cat, grep, git diff …) cannot overwrite anything, so they are let through.
     */
    const stale = await staleFilesNamedIn(context, params.command)
    if (stale.length > 0 && !isSafeCommand(params.command)) {
      return {
        content:
          `${stale.join(', ')} changed after you last read ${stale.length === 1 ? 'it' : 'them'} - another chat, the user or ` +
          'another program edited it. Read it again with read_file, then run the command against what is there now.',
        isError: true,
      }
    }
    const cwd = params.cwd !== undefined ? params.cwd : context.workspaceRoot
    /*
     * Layered over the inherited environment rather than replacing it: a command still needs PATH
     * and everything else the shell expects, and `TerminalRunOptions.env` is a patch, not a
     * replacement. Absent when the host supplies none, so the extension's call is byte-for-byte
     * the one it always made.
     */
    const proc = context.terminal.run(params.command, {
      cwd,
      ...(context.sessionEnv !== undefined ? { env: context.sessionEnv } : {}),
    })

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
