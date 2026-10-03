import fs from 'node:fs/promises'
import path from 'node:path'
import { findOnPath, languageFor, languageIdFor, LSP_LANGUAGES, type LspCandidate } from './catalog.js'
import { LspClient, type LspDiagnostic } from './client.js'

/** What any host offers for diagnostics: the extension through VS Code, the others through this. */
export interface DiagnosticsProvider {
  /** Diagnostics for one file as it is on disk now; undefined when no server covers its language. */
  diagnose(file: string): Promise<{ server: string; diagnostics: LspDiagnostic[] } | undefined>
  /** One line per language: which server, and whether it is installed or running. */
  status(): LanguageServerStatus[]
  dispose(): void
}

export interface LanguageServerStatus {
  language: string
  label: string
  extensions: string[]
  /** The command in use or found: an override, a detected server, or undefined (none installed). */
  command?: string
  state: 'running' | 'available' | 'not installed' | 'off' | 'failed'
  detail?: string
}

export interface LspSettings {
  enabled?: boolean | undefined
  servers?: Record<string, false | { command: string; args?: string[] | undefined }> | undefined
}

/**
 * Starts language servers lazily - the first time a file in that language is checked - and keeps
 * them for the session. A server that fails to start is remembered as failed for the session, so a
 * broken install costs one attempt rather than one per edit.
 */
export class LspManager implements DiagnosticsProvider {
  private clients = new Map<string, LspClient>()
  private failed = new Map<string, string>()

  constructor(
    private readonly root: string,
    private readonly settings: () => LspSettings,
    private readonly storageDir: string,
    private readonly log: (line: string) => void,
  ) {}

  private candidateFor(language: string): { candidate: LspCandidate; executable: string } | undefined {
    const configured = this.settings().servers?.[language]
    if (configured === false) return undefined
    const candidates = configured !== undefined ? [{ command: configured.command, args: configured.args ?? [] }] : (LSP_LANGUAGES.find((l) => l.id === language)?.candidates ?? [])
    for (const candidate of candidates) {
      const executable = findOnPath(candidate.command)
      if (executable !== undefined) return { candidate, executable }
    }
    return undefined
  }

  async diagnose(file: string): Promise<{ server: string; diagnostics: LspDiagnostic[] } | undefined> {
    if (this.settings().enabled === false) return undefined
    const language = languageFor(file)
    if (language === undefined || this.failed.has(language.id)) return undefined
    let client = this.clients.get(language.id)
    const firstUse = client === undefined
    if (client === undefined || client.exited) {
      const found = this.candidateFor(language.id)
      if (found === undefined) return undefined
      const args = [...found.candidate.args]
      // jdtls keeps its own index and needs a folder for it.
      if (language.id === 'java' && !args.includes('-data')) args.push('-data', path.join(this.storageDir, 'jdtls-workspace'))
      try {
        client = new LspClient(found.executable, args, this.root, this.log)
        this.clients.set(language.id, client)
      } catch (error) {
        this.failed.set(language.id, error instanceof Error ? error.message : String(error))
        return undefined
      }
    }
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return undefined
    }
    try {
      // A cold server indexes the project first; later files answer in a moment.
      const diagnostics = await client.diagnose(file, text, languageIdFor(language, file), firstUse ? 20_000 : 6_000)
      if (client.exited) {
        this.failed.set(language.id, client.lastError ?? 'stopped')
        return undefined
      }
      return { server: path.basename(client.executable).replace(/\.(exe|cmd|bat)$/i, ''), diagnostics: diagnostics ?? [] }
    } catch (error) {
      this.failed.set(language.id, error instanceof Error ? error.message : String(error))
      client.dispose()
      this.clients.delete(language.id)
      return undefined
    }
  }

  status(): LanguageServerStatus[] {
    const off = this.settings().enabled === false
    return LSP_LANGUAGES.map((language) => {
      const base = { language: language.id, label: language.label, extensions: language.extensions }
      if (off || this.settings().servers?.[language.id] === false) return { ...base, state: 'off' as const }
      const failure = this.failed.get(language.id)
      const found = this.candidateFor(language.id)
      const command = found?.executable
      if (failure !== undefined) return { ...base, ...(command !== undefined ? { command } : {}), state: 'failed' as const, detail: failure }
      const client = this.clients.get(language.id)
      if (client !== undefined && !client.exited) return { ...base, command: client.executable, state: 'running' as const }
      if (command !== undefined) return { ...base, command, state: 'available' as const }
      return {
        ...base,
        state: 'not installed' as const,
        detail: `Install one of: ${language.candidates.map((c) => c.command).join(', ')} — or name a command in Settings.`,
      }
    })
  }

  dispose(): void {
    for (const client of this.clients.values()) client.dispose()
    this.clients.clear()
  }
}

/** Diagnostics as a few lines for a tool result: errors first, capped. */
export function describeDiagnostics(shown: string, result: { server: string; diagnostics: LspDiagnostic[] }, cap = 20): string {
  const relevant = result.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning')
  if (relevant.length === 0) return `${result.server}: no errors or warnings in ${shown}.`
  const sorted = [...relevant].sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === 'error' ? -1 : 1))
  const errors = relevant.filter((d) => d.severity === 'error').length
  const lines = sorted.slice(0, cap).map((d) => `  ${shown}:${String(d.line)}:${String(d.column)} ${d.severity}: ${d.message.split('\n')[0] ?? ''}${d.code !== undefined ? ` [${d.code}]` : ''}`)
  return `${result.server}: ${String(errors)} error(s), ${String(relevant.length - errors)} warning(s) in ${shown}:\n${lines.join('\n')}${relevant.length > cap ? `\n  … ${String(relevant.length - cap)} more` : ''}`
}
