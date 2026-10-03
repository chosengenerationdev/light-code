import type { LanguageServerStatus, LspSettings } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { badgeStyle, colors, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'
const ready = 'var(--vscode-testing-iconPassed, var(--vscode-foreground))'

export interface LanguageServersState {
  /** `host`: the editor's own language support answers (VS Code). `servers`: started here. */
  provider: 'host' | 'servers' | 'none'
  settings: LspSettings
  languages: LanguageServerStatus[]
}

const STATE_COLOUR: Record<LanguageServerStatus['state'], string> = {
  running: ready,
  available: ready,
  'not installed': colors.muted,
  off: colors.muted,
  failed: colors.error,
}

/**
 * Language servers: after every edit the assistant sees the compile and type errors the change
 * introduced, and `get_diagnostics` checks any file. In VS Code that is the editor's own language
 * support; elsewhere the servers already installed on this machine are found and started on first
 * use. Nothing is downloaded - a missing language says what to install.
 */
export function LanguageServersSection(props: {
  lsp: LanguageServersState | undefined
  onSave: (settings: LspSettings) => void
  onRefresh: () => void
}): ReactElement | null {
  const { lsp } = props
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [command, setCommand] = useState('')
  if (lsp === undefined || lsp.provider === 'none') return null

  const enabled = lsp.settings.enabled !== false
  const servers = lsp.settings.servers ?? {}
  const working = lsp.languages.filter((l) => l.state === 'running' || l.state === 'available').length
  const summary = lsp.provider === 'host' ? 'From VS Code' : !enabled ? 'Off' : `${String(working)} of ${String(lsp.languages.length)} languages`

  const save = (next: LspSettings): void => props.onSave(next)
  const setServer = (language: string, value: false | { command: string; args?: string[] } | undefined): void => {
    const nextServers = { ...servers }
    if (value === undefined) delete nextServers[language]
    else nextServers[language] = value
    save({ ...lsp.settings, servers: nextServers })
  }

  return (
    <Panel id="tools.languageServers" title="Language servers" summary={summary}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        After every edit the assistant is told the errors and warnings its change produced, and{' '}
        <code style={{ fontFamily: monospace }}>get_diagnostics</code> checks any file without running a build.
      </p>
      {lsp.provider === 'host' ? (
        <p style={{ fontSize: 12, margin: 0 }}>
          This uses VS Code's own language support, so every language you have an extension for is covered and nothing
          extra runs. To add a language, install its VS Code extension.
        </p>
      ) : (
        <>
          <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
            Servers already installed on this machine are found on PATH and started the first time a file in that
            language is checked. Nothing is downloaded.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={(event) => save({ ...lsp.settings, enabled: event.target.checked })} />
            <span style={{ fontSize: 13 }}>Check edits with language servers</span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: enabled ? 1 : 0.6 }}>
            {lsp.languages.map((language) => {
              const override = servers[language.language]
              return (
                <div key={language.language} style={{ borderBottom: `1px solid ${colors.border}`, paddingBottom: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, flex: '1 1 auto' }}>{language.label}</span>
                    <span style={{ ...badgeStyle(), color: STATE_COLOUR[language.state] }}>{language.state}</span>
                    {override !== false ? (
                      <button type="button" style={secondaryButtonStyle()} onClick={() => setServer(language.language, false)}>
                        Turn off
                      </button>
                    ) : (
                      <button type="button" style={secondaryButtonStyle()} onClick={() => setServer(language.language, undefined)}>
                        Turn on
                      </button>
                    )}
                    <button
                      type="button"
                      style={secondaryButtonStyle()}
                      onClick={() => {
                        setEditing(editing === language.language ? undefined : language.language)
                        setCommand(override !== false && override !== undefined ? [override.command, ...(override.args ?? [])].join(' ') : '')
                      }}
                    >
                      Command…
                    </button>
                  </div>
                  {language.command !== undefined && (
                    <div style={{ color: colors.muted, fontSize: 11, fontFamily: monospace, wordBreak: 'break-all' }}>{language.command}</div>
                  )}
                  {language.detail !== undefined && <div style={{ color: language.state === 'failed' ? colors.error : colors.muted, fontSize: 11 }}>{language.detail}</div>}
                  {editing === language.language && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <input
                        aria-label={`Command for ${language.label}`}
                        value={command}
                        placeholder="e.g. C:\tools\pyright-langserver.cmd --stdio"
                        onChange={(event) => setCommand(event.target.value)}
                        style={{ ...textFieldStyle(), flex: 1, fontFamily: monospace }}
                      />
                      <button
                        type="button"
                        style={secondaryButtonStyle()}
                        onClick={() => {
                          const parts = splitCommand(command)
                          const [first, ...rest] = parts
                          setServer(language.language, first === undefined ? undefined : { command: first, ...(rest.length > 0 ? { args: rest } : {}) })
                          setEditing(undefined)
                        }}
                      >
                        {command.trim() === '' ? 'Use detected' : 'Save'}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <button type="button" style={{ ...secondaryButtonStyle(), marginTop: 8 }} onClick={props.onRefresh}>
            Check again
          </button>
        </>
      )}
    </Panel>
  )
}

/** Splits a typed command line into words, keeping "quoted parts" together (paths with spaces). */
export function splitCommand(text: string): string[] {
  const words: string[] = []
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) words.push(match[1] ?? match[2] ?? '')
  return words.filter((w) => w.length > 0)
}
