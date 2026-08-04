import type { ApprovalDecision, ToolGroup, ToolPreview } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { colors, fontFamily, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'
import { DiffView } from './DiffView.js'

export interface PendingApproval {
  id: string
  toolName: string
  group: ToolGroup
  preview: ToolPreview
}

export interface ApprovalPromptProps {
  approval: PendingApproval
  onDecide: (id: string, decision: ApprovalDecision) => void
}

const monospace = 'var(--vscode-editor-font-family, monospace)'

function describeGroup(group: ToolGroup): string {
  switch (group) {
    case 'edit':
      return 'wants to modify a file'
    case 'command':
      return 'wants to run a command'
    case 'read':
      return 'wants to read from the workspace'
    case 'mcp':
      return 'wants to use an external tool'
    default:
      return 'wants to act'
  }
}

/**
 * Renders only ground truth — the computed diff or the literal command line — never the
 * model's own description of what it intends to do. See CLAUDE.md invariant 8.
 */
function PreviewBody(props: { preview: ToolPreview }): ReactElement {
  const { preview } = props
  if (preview.kind === 'diff') {
    return <DiffView path={preview.path} before={preview.before} after={preview.after} />
  }
  if (preview.kind === 'command') {
    return (
      <div>
        <div style={{ color: colors.muted, fontSize: 11, marginBottom: 4 }}>in {preview.cwd}</div>
        <pre
          style={{
            margin: 0,
            padding: '8px 10px',
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            fontFamily: monospace,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {preview.command}
        </pre>
      </div>
    )
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: '8px 10px',
        border: `1px solid ${colors.border}`,
        borderRadius: 4,
        fontFamily: monospace,
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {preview.text}
    </pre>
  )
}

export function ApprovalPrompt(props: ApprovalPromptProps): ReactElement {
  const { approval } = props
  return (
    <div
      style={{
        margin: '6px 8px',
        padding: 10,
        borderRadius: 4,
        border: `1px solid ${colors.focusBorder}`,
        fontFamily,
      }}
    >
      <div style={{ marginBottom: 8, fontSize: 12 }}>
        <span style={{ fontFamily: monospace }}>{approval.toolName}</span>{' '}
        <span style={{ color: colors.muted }}>{describeGroup(approval.group)}</span>
      </div>

      <PreviewBody preview={approval.preview} />

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={() => props.onDecide(approval.id, 'approve')}>
          Approve
        </button>
        <button type="button" style={secondaryButtonStyle()} onClick={() => props.onDecide(approval.id, 'deny')}>
          Deny
        </button>
      </div>
    </div>
  )
}
