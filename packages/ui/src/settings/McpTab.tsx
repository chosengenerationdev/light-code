import type { McpServerState, McpServerStatus } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, fieldErrorStyle, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'

export interface McpTabProps {
  servers: McpServerState[]
  json: string
  warnings: Record<string, string[]>
  saveError: string | undefined
  onSave: (json: string) => void
  onRestart: (name: string) => void
}

const monospace = 'var(--vscode-editor-font-family, monospace)'

const STATUS_COLOR: Record<McpServerStatus, string> = {
  ready: 'var(--vscode-testing-iconPassed, #3fb950)',
  connecting: 'var(--vscode-descriptionForeground)',
  idle: 'var(--vscode-descriptionForeground)',
  disabled: 'var(--vscode-descriptionForeground)',
  failed: 'var(--vscode-errorForeground)',
}

function ServerRow(props: { server: McpServerState; warnings: string[]; onRestart: (name: string) => void }): ReactElement {
  const { server } = props
  return (
    <div style={{ padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: STATUS_COLOR[server.status], fontSize: 10 }}>●</span>
        <strong style={{ fontFamily: monospace, fontSize: 12 }}>{server.name}</strong>
        <span style={{ color: colors.muted, fontSize: 11 }}>{server.status}</span>
        {server.status === 'ready' && (
          <span style={{ color: colors.muted, fontSize: 11 }}>
            {server.toolNames.length} tool{server.toolNames.length === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          style={{ ...secondaryButtonStyle(), marginLeft: 'auto' }}
          onClick={() => props.onRestart(server.name)}
        >
          Restart
        </button>
      </div>
      {server.error !== undefined && <div style={fieldErrorStyle()}>{server.error}</div>}
      {props.warnings.map((warning) => (
        <div key={warning} style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
          ⚠ {warning}
        </div>
      ))}
      {server.toolNames.length > 0 && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 4, fontFamily: monospace, wordBreak: 'break-word' }}>
          {server.toolNames.join(', ')}
        </div>
      )}
    </div>
  )
}

export function McpTab(props: McpTabProps): ReactElement {
  const [draft, setDraft] = useState(props.json)

  // The host is the source of truth; resync when it sends new JSON (same prop-sync
  // pattern as the provider form — `useState`'s initial value applies only once).
  useEffect(() => {
    setDraft(props.json)
  }, [props.json])

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily }}>
      <h3 style={{ margin: '0 0 4px', color: colors.foreground }}>MCP Servers</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0 }}>
        Uses the standard <code style={{ fontFamily: monospace }}>mcpServers</code> shape, so a config from another MCP
        client can be pasted in unchanged. Every MCP tool is approval-gated like any other tool.
      </p>

      {props.servers.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle()}>Status</label>
          {props.servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              warnings={props.warnings[server.name] ?? []}
              onRestart={props.onRestart}
            />
          ))}
        </div>
      )}

      <label htmlFor="lc-mcp-json" style={labelStyle()}>
        Configuration
      </label>
      <textarea
        id="lc-mcp-json"
        value={draft}
        spellCheck={false}
        rows={14}
        onChange={(event) => setDraft(event.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: colors.inputBackground,
          color: colors.inputForeground,
          border: `1px solid ${props.saveError !== undefined ? colors.error : colors.inputBorder}`,
          borderRadius: 2,
          padding: '6px 8px',
          fontFamily: monospace,
          fontSize: 12,
          resize: 'vertical',
        }}
      />
      {props.saveError !== undefined && <span style={fieldErrorStyle()}>{props.saveError}</span>}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={() => props.onSave(draft)}>
          Save
        </button>
        <button type="button" style={secondaryButtonStyle()} onClick={() => setDraft(props.json)}>
          Revert
        </button>
      </div>

      <p style={{ color: colors.muted, fontSize: 11, marginTop: 12 }}>
        Secrets: use <code style={{ fontFamily: monospace }}>{'${secret:NAME}'}</code> in an env value or header. The
        value is read from secret storage at launch and never written to the config file.
      </p>
    </div>
  )
}
