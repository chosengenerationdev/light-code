import type { McpServerState, McpServerStatus, McpToolPermission } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, fieldErrorStyle, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'

export interface McpTabProps {
  servers: McpServerState[]
  json: string
  warnings: Record<string, string[]>
  saveError: string | undefined
  onSave: (json: string) => void
  onRestart: (name: string) => void
  onSetServerEnabled: (name: string, enabled: boolean) => void
  onSetToolPermission: (server: string, tool: string, permission: McpToolPermission) => void
  onConnect: (name: string) => void
}

const monospace = 'var(--vscode-editor-font-family, monospace)'

const STATUS_COLOR: Record<McpServerStatus, string> = {
  ready: 'var(--vscode-testing-iconPassed, #3fb950)',
  connecting: 'var(--vscode-descriptionForeground)',
  idle: 'var(--vscode-descriptionForeground)',
  disabled: 'var(--vscode-descriptionForeground)',
  failed: 'var(--vscode-errorForeground)',
}

const PERMISSIONS: { value: McpToolPermission; label: string; title: string }[] = [
  { value: 'always', label: 'Always', title: 'Run without asking, in this workspace' },
  { value: 'ask', label: 'Ask', title: 'Ask for approval every time' },
  { value: 'never', label: 'Never', title: 'Hide this tool from the model entirely' },
]

function PermissionPicker(props: {
  value: McpToolPermission
  onChange: (permission: McpToolPermission) => void
}): ReactElement {
  return (
    <div style={{ display: 'flex', flexShrink: 0 }}>
      {PERMISSIONS.map((option, index) => {
        const selected = option.value === props.value
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            onClick={() => props.onChange(option.value)}
            style={{
              padding: '1px 7px',
              fontFamily,
              fontSize: 10,
              cursor: 'pointer',
              background: selected ? colors.buttonBackground : 'transparent',
              color: selected ? colors.buttonForeground : colors.muted,
              border: `1px solid ${selected ? colors.buttonBackground : colors.border}`,
              borderLeftWidth: index === 0 ? 1 : 0,
              borderTopLeftRadius: index === 0 ? 3 : 0,
              borderBottomLeftRadius: index === 0 ? 3 : 0,
              borderTopRightRadius: index === PERMISSIONS.length - 1 ? 3 : 0,
              borderBottomRightRadius: index === PERMISSIONS.length - 1 ? 3 : 0,
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** `idle` is accurate but unhelpful — say what it means and what will happen. */
const STATUS_LABEL: Record<McpServerStatus, string> = {
  ready: 'ready',
  connecting: 'starting…',
  idle: 'not started',
  disabled: 'disabled',
  failed: 'failed',
}

function ServerRow(props: {
  server: McpServerState
  warnings: string[]
  onRestart: (name: string) => void
  onConnect: (name: string) => void
  onSetServerEnabled: (name: string, enabled: boolean) => void
  onSetToolPermission: (server: string, tool: string, permission: McpToolPermission) => void
}): ReactElement {
  const { server } = props
  const [expanded, setExpanded] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const started = server.status === 'ready' || server.status === 'connecting'

  return (
    <div style={{ borderBottom: `1px solid ${colors.border}`, padding: '6px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            background: 'transparent',
            border: 'none',
            color: colors.muted,
            cursor: 'pointer',
            padding: 0,
            width: 14,
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span style={{ color: STATUS_COLOR[server.status], fontSize: 10 }}>●</span>
        <strong style={{ fontFamily: monospace, fontSize: 12 }}>{server.name}</strong>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          {STATUS_LABEL[server.status]}
          {server.status === 'ready' && ` · ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`}
        </span>

        <label
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}
          title="Disabling removes this server's tools from the model entirely"
        >
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(event) => props.onSetServerEnabled(server.name, event.target.checked)}
          />
          Enabled
        </label>
        {server.enabled && !started && (
          <button type="button" style={secondaryButtonStyle()} onClick={() => props.onConnect(server.name)}>
            Connect
          </button>
        )}
        {started && (
          <button type="button" style={secondaryButtonStyle()} onClick={() => props.onRestart(server.name)}>
            Restart
          </button>
        )}
      </div>

      {server.error !== undefined && <div style={fieldErrorStyle()}>{server.error}</div>}
      {props.warnings.map((warning) => (
        <div key={warning} style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
          ⚠ {warning}
        </div>
      ))}

      {server.logs.length > 0 && (
        <div style={{ marginTop: 4, paddingLeft: 22 }}>
          <button
            type="button"
            onClick={() => setShowLogs(!showLogs)}
            style={{
              background: 'transparent',
              border: 'none',
              color: colors.muted,
              cursor: 'pointer',
              padding: 0,
              fontFamily,
              fontSize: 11,
            }}
          >
            {showLogs ? '▾' : '▸'} Log ({server.logs.length})
          </button>
          {showLogs && (
            <pre
              style={{
                margin: '4px 0 0',
                padding: 6,
                maxHeight: 160,
                overflow: 'auto',
                background: colors.inputBackground,
                border: `1px solid ${colors.border}`,
                borderRadius: 3,
                fontFamily: monospace,
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {server.logs.join('\n')}
            </pre>
          )}
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 6, paddingLeft: 22 }}>
          {server.tools.length === 0 ? (
            <p style={{ color: colors.muted, fontSize: 11, margin: 0 }}>
              {server.enabled
                ? 'No tools discovered yet — press Connect, or they load on first use.'
                : 'Enable this server to see its tools.'}
            </p>
          ) : (
            server.tools.map((tool) => (
              <div
                key={tool.name}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: monospace, fontSize: 12 }}>{tool.name}</span>
                  {tool.description.length > 0 && (
                    <span
                      style={{
                        display: 'block',
                        color: colors.muted,
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={tool.description}
                    >
                      {tool.description}
                    </span>
                  )}
                </span>
                <PermissionPicker
                  value={tool.permission}
                  onChange={(permission) => props.onSetToolPermission(server.name, tool.name, permission)}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function McpTab(props: McpTabProps): ReactElement {
  const [draft, setDraft] = useState(props.json)
  const [editing, setEditing] = useState(false)

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
        client can be pasted in unchanged.
      </p>

      {props.servers.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 12 }}>No servers configured yet.</p>
      ) : (
        props.servers.map((server) => (
          <ServerRow
            key={server.name}
            server={server}
            warnings={props.warnings[server.name] ?? []}
            onRestart={props.onRestart}
            onConnect={props.onConnect}
            onSetServerEnabled={props.onSetServerEnabled}
            onSetToolPermission={props.onSetToolPermission}
          />
        ))
      )}

      <div style={{ marginTop: 16 }}>
        <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(!editing)}>
          {editing ? 'Hide configuration' : 'Edit configuration'}
        </button>
      </div>

      {editing && (
        <div style={{ marginTop: 10 }}>
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
            Secrets: use <code style={{ fontFamily: monospace }}>{'${secret:NAME}'}</code> in an env value or header.
            The value is read from secret storage at launch and never written to the config file.
          </p>
        </div>
      )}
    </div>
  )
}
