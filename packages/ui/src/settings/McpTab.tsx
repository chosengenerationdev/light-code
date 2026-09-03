import type { McpPlatform, McpServerConfig, McpServerState, McpServerStatus, McpToolPermission } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { CopyIcon, TrashIcon } from '../icons.js'
import {
  colors,
  fieldErrorStyle,
  fontFamily,
  iconButtonStyle,
  labelStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
} from '../theme.js'
import { McpServerForm } from './McpServerForm.js'
import type { BrowseRequest } from './PathField.js'

export interface McpTabProps {
  servers: McpServerState[]
  json: string
  warnings: Record<string, string[]>
  saveError: string | undefined
  /** Each server as stored, so the form can edit one without reparsing the JSON. */
  configs: Record<string, McpServerConfig>
  /** Decides the virtualenv interpreter layout the form derives. */
  platform: McpPlatform
  /** Increments when the host confirms a save reached disk. */
  savedTick: number
  /** Result of the last interpreter probe. */
  pythonProbe: { interpreter?: string; venvDir?: string; detail: string } | undefined
  onDetectPython: (venvDir: string, script: string) => void
  onBrowse: (request: BrowseRequest) => void
  pickedPath: { purpose: string; path: string } | undefined
  onSave: (json: string) => void
  onSaveServer: (name: string, previousName: string | undefined, config: McpServerConfig) => void
  onDeleteServer: (name: string) => void
  onDuplicateServer: (name: string) => void
  onRestart: (name: string) => void
  onSetServerEnabled: (name: string, enabled: boolean) => void
  onSetToolPermission: (server: string, tool: string, permission: McpToolPermission) => void
  /** Seconds, or undefined to clear the override and fall back to the server's own timeout. */
  onSetToolTimeout: (server: string, tool: string, seconds?: number) => void
  onConnect: (name: string) => void
  /*
   * The documentation index, surfaced here as well as in the Search tab.
   *
   * A server's tools are indexed so `search_docs` can find them, and adding a server already
   * triggers a reindex on connect. But that happens silently, seconds later, in a tab the user
   * is not looking at — so after adding a server there was no way to tell whether it had
   * happened, and no way to make it happen. The control belongs where the change was made.
   */
  docsIndex: { enabled: boolean; ready: boolean; indexing: boolean; result: string | undefined } | undefined
  onIndexDocs: () => void
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
              background: selected ? colors.accent : 'transparent',
              color: selected ? colors.buttonForeground : colors.muted,
              border: `1px solid ${selected ? colors.accent : colors.border}`,
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
  transport: string
  warnings: string[]
  onRestart: (name: string) => void
  onConnect: (name: string) => void
  onSetServerEnabled: (name: string, enabled: boolean) => void
  onSetToolPermission: (server: string, tool: string, permission: McpToolPermission) => void
  onSetToolTimeout: (server: string, tool: string, seconds?: number) => void
  onEdit: (name: string) => void
  onDelete: (name: string) => void
  onDuplicate: (name: string) => void
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
          {/*
            Inferred from the entry's shape, never stored — `command` is stdio, `url` is
            HTTP (§11). Shown because it is the first thing anyone debugging a server wants
            to know, and nothing else on this row reveals it.
          */}
          {props.transport}
          {' · '}
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
        <button type="button" style={secondaryButtonStyle()} onClick={() => props.onEdit(server.name)}>
          Edit
        </button>
        {/*
          Copies the entry disabled, so a clone made to be edited does not spawn a second
          identical server the moment it exists.
        */}
        <button
          type="button"
          aria-label={`Duplicate ${server.name}`}
          title="Duplicate this server. The copy starts disabled so you can edit it first."
          style={iconButtonStyle('ghost')}
          onClick={() => props.onDuplicate(server.name)}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          aria-label={`Delete ${server.name}`}
          title="Remove this server"
          style={iconButtonStyle('ghost')}
          onClick={() => props.onDelete(server.name)}
        >
          <TrashIcon />
        </button>
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
                <TimeoutBox
                  value={tool.timeout}
                  onChange={(seconds) => props.onSetToolTimeout(server.name, tool.name, seconds)}
                />
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
  /** `''` means a new server; `undefined` means the form is closed. */
  const [formFor, setFormFor] = useState<string | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  // The host is the source of truth; resync when it sends new JSON (same prop-sync
  // pattern as the provider form — `useState`'s initial value applies only once).
  useEffect(() => {
    setDraft(props.json)
  }, [props.json])

  // Closes only once the host confirms the write landed, so a rejected save keeps the
  // form and its values rather than discarding both — same reasoning as the search form.
  useEffect(() => {
    if (!saving) return
    setSaving(false)
    setFormFor(undefined)
  }, [props.savedTick])

  if (formFor !== undefined) {
    return (
      <McpServerForm
        initialName={formFor}
        initialConfig={props.configs[formFor]}
        existingNames={props.servers.map((server) => server.name)}
        platform={props.platform}
        saving={saving}
        probe={props.pythonProbe}
        onDetect={props.onDetectPython}
        onBrowse={props.onBrowse}
        pickedPath={props.pickedPath}
        onSave={(name, previousName, config) => {
          setSaving(true)
          props.onSaveServer(name, previousName, config)
        }}
        onCancel={() => setFormFor(undefined)}
      />
    )
  }

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
          <div key={server.name}>
            <ServerRow
              server={server}
              transport={props.configs[server.name] !== undefined && 'url' in props.configs[server.name]! ? 'HTTP' : 'stdio'}
              warnings={props.warnings[server.name] ?? []}
              onRestart={props.onRestart}
              onConnect={props.onConnect}
              onSetServerEnabled={props.onSetServerEnabled}
              onSetToolPermission={props.onSetToolPermission}
              onSetToolTimeout={props.onSetToolTimeout}
              onEdit={setFormFor}
              onDelete={setConfirmDelete}
            onDuplicate={props.onDuplicateServer}
            />
            {confirmDelete === server.name && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 6px 22px', fontSize: 12 }}>
                <span>Remove {server.name}?</span>
                <button
                  type="button"
                  style={secondaryButtonStyle()}
                  onClick={() => {
                    props.onDeleteServer(server.name)
                    setConfirmDelete(undefined)
                  }}
                >
                  Remove
                </button>
                <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirmDelete(undefined)}>
                  Keep
                </button>
              </div>
            )}
          </div>
        ))
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={() => setFormFor('')}>
          Add server
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          title="Edit every server as raw JSON — for pasting a config from another client"
          onClick={() => setEditing(!editing)}
        >
          {editing ? 'Hide JSON' : 'Edit as JSON'}
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

      {props.docsIndex?.enabled === true && (
        <div style={{ marginTop: 20, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>Tool documentation index</div>
          <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
            Tool schemas are kept out of every request and looked up on demand, so a new server&rsquo;s
            tools have to be indexed before they can be found by meaning. That happens on its own a
            few seconds after a server connects &mdash; this button is for when you would rather not
            wonder.{' '}
            {props.docsIndex.ready
              ? ''
              : 'No embedding model is configured, so tools are matched on names and descriptions instead. They stay findable either way.'}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={secondaryButtonStyle()}
              disabled={props.docsIndex.indexing || !props.docsIndex.ready}
              onClick={props.onIndexDocs}
            >
              {props.docsIndex.indexing ? 'Indexing…' : 'Reindex tool documentation'}
            </button>
            {props.docsIndex.result !== undefined && (
              <span style={{ color: colors.muted, fontSize: 11 }}>{props.docsIndex.result}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One tool's own timeout, in seconds.
 *
 * A server's timeout is a single number for everything it exposes, which is the wrong shape for
 * the usual server: twenty quick lookups and one report that takes four minutes. Raising the
 * server-wide limit to suit the slow one means a genuinely hung quick call now hangs for four
 * minutes too.
 *
 * Committed on blur or Enter rather than per keystroke, because typing "120" would otherwise
 * save 1, then 12, then 120 — and the middle values are real settings that briefly applied.
 */
function TimeoutBox(props: { value: number | undefined; onChange: (seconds?: number) => void }): ReactElement {
  const [draft, setDraft] = useState(props.value === undefined ? '' : String(props.value))
  // Resynced when the host confirms, so a rejected value does not linger as though it were saved.
  useEffect(() => setDraft(props.value === undefined ? '' : String(props.value)), [props.value])

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) {
      props.onChange()
      return
    }
    const seconds = Number(trimmed)
    // Refused rather than clamped: a typo should not silently become a limit nobody chose.
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
      setDraft(props.value === undefined ? '' : String(props.value))
      return
    }
    props.onChange(Math.round(seconds))
  }

  return (
    <input
      inputMode="numeric"
      value={draft}
      placeholder="server"
      title="Seconds this tool may take. Blank uses the server's timeout. Raise it for one slow tool rather than raising the server's."
      aria-label="Timeout in seconds"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      style={{
        width: 62,
        flexShrink: 0,
        background: colors.inputBackground,
        color: colors.inputForeground,
        border: `1px solid ${colors.inputBorder}`,
        borderRadius: 2,
        padding: '1px 4px',
        fontFamily,
        fontSize: 11,
        textAlign: 'right',
      }}
    />
  )
}
