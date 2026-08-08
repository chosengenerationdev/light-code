import type { ApprovableGroup, WorkspaceApprovals } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { colors, fontFamily, labelStyle, secondaryButtonStyle } from '../theme.js'

export interface ApprovalsTabProps {
  approvals: WorkspaceApprovals
  onSetAutoApprove: (group: ApprovableGroup, enabled: boolean) => void
  onRevokeTool: (toolName: string) => void
  onRevokeCommand: (command: string) => void
}

const monospace = 'var(--vscode-editor-font-family, monospace)'

const CATEGORIES: { group: ApprovableGroup; label: string; description: string }[] = [
  { group: 'read', label: 'Reading files', description: 'read_file, list_files, search_files' },
  { group: 'edit', label: 'Editing files', description: 'write_to_file, apply_diff' },
  { group: 'command', label: 'Running commands', description: 'execute_command — the broadest grant here' },
  { group: 'mcp', label: 'MCP tools', description: 'Tools provided by external MCP servers' },
]

function Toggle(props: { checked: boolean; label: string; description: string; onChange: (v: boolean) => void }): ReactElement {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10, cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        style={{ marginTop: 2 }}
      />
      <span>
        <span style={{ display: 'block', fontSize: 13 }}>{props.label}</span>
        <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>{props.description}</span>
      </span>
    </label>
  )
}

function RevocableList(props: {
  title: string
  empty: string
  entries: string[]
  onRevoke: (entry: string) => void
}): ReactElement {
  return (
    <div style={{ marginTop: 16 }}>
      <label style={labelStyle()}>{props.title}</label>
      {props.entries.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 12, margin: 0 }}>{props.empty}</p>
      ) : (
        props.entries.map((entry) => (
          <div
            key={entry}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 0',
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <code style={{ flex: 1, fontFamily: monospace, fontSize: 12, wordBreak: 'break-all' }}>{entry}</code>
            <button type="button" style={secondaryButtonStyle()} onClick={() => props.onRevoke(entry)}>
              Revoke
            </button>
          </div>
        ))
      )}
    </div>
  )
}

export function ApprovalsTab(props: ApprovalsTabProps): ReactElement {
  const auto = props.approvals.autoApprove ?? {}

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily }}>
      <h3 style={{ margin: '0 0 4px', color: colors.foreground }}>Approvals</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0, marginBottom: 12 }}>
        These apply to this workspace only, and are stored outside it — a repository cannot grant itself permissions.
      </p>

      <label style={labelStyle()}>Skip the prompt for…</label>
      {CATEGORIES.map((category) => (
        <Toggle
          key={category.group}
          checked={auto[category.group] === true}
          label={category.label}
          description={category.description}
          onChange={(enabled) => props.onSetAutoApprove(category.group, enabled)}
        />
      ))}

      <RevocableList
        title="Always-allowed tools"
        empty="None. Use “Always allow” on an approval prompt to add one."
        entries={props.approvals.allowedTools ?? []}
        onRevoke={props.onRevokeTool}
      />

      <RevocableList
        title="Always-allowed commands (exact match)"
        empty="None. Use “Always allow this command” on a command prompt to add one."
        entries={props.approvals.allowedCommands ?? []}
        onRevoke={props.onRevokeCommand}
      />
      <p style={{ color: colors.muted, fontSize: 11 }}>
        A command is matched byte-for-byte. Allowing <code style={{ fontFamily: monospace }}>npm test</code> does not
        allow <code style={{ fontFamily: monospace }}>npm test &amp;&amp; something-else</code>.
      </p>
    </div>
  )
}
