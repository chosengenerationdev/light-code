import * as vscode from 'vscode'
import type { DiagnosticsProvider, LanguageServerStatus, LspDiagnostic } from '@light-code/core'

/**
 * Diagnostics from VS Code's own language support - whatever extensions the user has (Python,
 * TypeScript, Java, C#, Go, ...) are already running language servers, so nothing is started here.
 *
 * After an edit on disk, VS Code's file watcher updates the document and its language server
 * re-reports. This opens the document (so a server that only analyses open files looks at it) and
 * waits for the next report, or a short quiet period when nothing changes.
 */
export function createVSCodeDiagnostics(): DiagnosticsProvider {
  const SEVERITY: Record<number, LspDiagnostic['severity']> = {
    [vscode.DiagnosticSeverity.Error]: 'error',
    [vscode.DiagnosticSeverity.Warning]: 'warning',
    [vscode.DiagnosticSeverity.Information]: 'info',
    [vscode.DiagnosticSeverity.Hint]: 'hint',
  }
  return {
    async diagnose(file) {
      const uri = vscode.Uri.file(file)
      let languageId: string
      try {
        languageId = (await vscode.workspace.openTextDocument(uri)).languageId
      } catch {
        return undefined
      }
      if (languageId === 'plaintext') return undefined
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 3000)
        const listener = vscode.languages.onDidChangeDiagnostics((event) => {
          if (event.uris.some((u) => u.toString() === uri.toString())) setTimeout(done, 300)
        })
        function done(): void {
          clearTimeout(timer)
          listener.dispose()
          resolve()
        }
      })
      return {
        server: `VS Code (${languageId})`,
        diagnostics: vscode.languages.getDiagnostics(uri).map((d) => ({
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: SEVERITY[d.severity] ?? 'error',
          message: d.message,
          ...(d.source !== undefined ? { source: d.source } : {}),
          ...(d.code !== undefined ? { code: String(typeof d.code === 'object' ? d.code.value : d.code) } : {}),
        })),
      }
    },
    status(): LanguageServerStatus[] {
      return []
    },
    dispose() {},
  }
}
