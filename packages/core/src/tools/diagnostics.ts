import { z } from 'zod'
import { describeDiagnostics } from '../lsp/manager.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolExecutionContext, ToolResult } from './types.js'

/**
 * `get_diagnostics`: what the language server says about files - type errors, undefined names,
 * bad imports - without running a build. Registered where the host offers diagnostics: VS Code
 * (its own language support) and the Node host, Sun and PyCharm (installed language servers).
 */
const schema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(20).describe('Files to check.'),
})

export const getDiagnosticsTool: Tool<z.infer<typeof schema>> = {
  name: 'get_diagnostics',
  group: 'read',
  description:
    'Compile errors, type errors and warnings for files, from the language server (Python, TypeScript/JavaScript, ' +
    'Java, C#, Go, Rust, C/C++ and more, where installed) — without running a build. After edits, the edit result ' +
    'already lists new problems in that file; use this to check other files that depend on it.',
  parametersSchema: schema,
  async execute(params, context): Promise<ToolResult> {
    if (context.diagnostics === undefined) return { content: 'No language support is available here.', isError: true }
    const parts: string[] = []
    for (const target of params.paths) {
      const resolved = await resolveToolPath(context, target)
      if (!resolved.ok) {
        parts.push(`${target}: ${resolved.message}`)
        continue
      }
      const result = await context.diagnostics.diagnose(resolved.realPath)
      parts.push(result === undefined ? `${target}: no language server for this file type is installed.` : describeDiagnostics(target, result))
    }
    return { content: parts.join('\n\n') }
  },
}

/**
 * Appended to an edit's result: what the language server now says about the file. Best effort -
 * a missing or slow server adds nothing rather than failing an edit that already happened.
 */
export async function diagnosticsAfterEdit(context: ToolExecutionContext, realPath: string, shown: string): Promise<string> {
  // A JupyterHub codebase saves the edit to the hub first; what happened belongs in the result.
  let saved = ''
  if (context.afterEdit !== undefined) {
    try {
      const note = await context.afterEdit(realPath)
      if (note !== undefined) saved = `\n\n${note}`
    } catch (error) {
      saved = `\n\nJupyterHub: NOT saved to the hub - ${error instanceof Error ? error.message : String(error)}. The edit is kept here; hub_sync "push" retries.`
    }
  }
  return saved + (await languageDiagnostics(context, realPath, shown))
}

async function languageDiagnostics(context: ToolExecutionContext, realPath: string, shown: string): Promise<string> {
  if (context.diagnostics === undefined) return ''
  try {
    const result = await context.diagnostics.diagnose(realPath)
    return result === undefined ? '' : `\n\n${describeDiagnostics(shown, result, 10)}`
  } catch {
    return ''
  }
}
