import type { ApprovalDecision, ToolGroup, ToolPreview } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { CheckIcon, CrossIcon } from '../icons.js'
import { colors, fontFamily, iconButtonStyle, secondaryButtonStyle } from '../theme.js'
import { DiffView } from './DiffView.js'

export interface PendingApproval {
  id: string
  toolName: string
  group: ToolGroup
  preview: ToolPreview
  /** `folder` means "always" grants a directory, not the tool. See `ApprovalRequest`. */
  alwaysScope?: 'folder'
}

export interface ApprovalPromptProps {
  approval: PendingApproval
  onDecide: (id: string, decision: ApprovalDecision) => void
  /** Approve now *and* remember, scoped to this workspace. */
  onAlwaysAllow: (id: string, scope: 'tool' | 'command' | 'folder') => void
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
    return (
      <div>
        {/*
          Where the change came from, when it did not come from this conversation. Source another
          model wrote is judged differently from source the assistant you are talking to wrote,
          and this prompt is the only place that can be said before the file exists.
        */}
        {preview.note !== undefined && (
          <div style={{ color: colors.muted, fontSize: 11, marginBottom: 4 }}>{preview.note}</div>
        )}
        <DiffView path={preview.path} before={preview.before} after={preview.after} />
      </div>
    )
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
      className="lc-fade-up"
      style={{
        margin: '6px 10px 6px 40px',
        padding: 10,
        borderRadius: 12,
        // The accent, not focusBorder: this is the one thing on screen waiting for you, and
        // it should be unmistakably the app asking rather than a generic focused box.
        border: `1px solid ${colors.accent}`,
        boxShadow: `0 0 0 3px ${colors.accentSoft}`,
        fontFamily,
      }}
    >
      <div style={{ marginBottom: 8, fontSize: 12 }}>
        <span style={{ fontFamily: monospace }}>{approval.toolName}</span>{' '}
        <span style={{ color: colors.muted }}>{describeGroup(approval.group)}</span>
      </div>

      <PreviewBody preview={approval.preview} />

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {/* Approve and Deny become icons: a tick and a cross are unambiguous, and these two
            are the pair every approval dialog has ever had. The "always allow" control below
            deliberately keeps its words — see the comment there. */}
        <button
          type="button"
          className="lc-btn-accent"
          title="Approve — run this once"
          aria-label="Approve, run this once"
          style={{ ...iconButtonStyle('primary'), width: 34 }}
          onClick={() => props.onDecide(approval.id, 'approve')}
        >
          <CheckIcon size={16} />
        </button>
        <button
          type="button"
          title="Deny — do not run this"
          aria-label="Deny, do not run this"
          style={{ ...iconButtonStyle('secondary'), width: 34 }}
          onClick={() => props.onDecide(approval.id, 'deny')}
        >
          <CrossIcon size={16} />
        </button>
        {/*
          * **These keep their text on purpose, against the icons-everywhere rule.**
          *
          * The difference between "run this once" and "never ask me about this again" is a
          * standing grant, and it is precisely the distinction an icon cannot carry. A user
          * who mis-taps a glyph here does not lose a click, they lose the approval gate for
          * that command for the rest of the workspace's life. Invariant 8 exists so this
          * surface tells the truth; a wordless button would undo that for tidiness.
          */}
        {approval.alwaysScope === 'folder' ? (
          <button
            type="button"
            style={secondaryButtonStyle()}
            title="Always allow reads from the folder this file is in. Added to Settings -> Approvals -> Folders, where you can remove it."
            onClick={() => props.onAlwaysAllow(approval.id, 'folder')}
          >
            Always allow this folder
          </button>
        ) : approval.preview.kind === 'command' ? (
          <button
            type="button"
            style={secondaryButtonStyle()}
            title="Allow this exact command string in this workspace. Anything appended still prompts."
            onClick={() => props.onAlwaysAllow(approval.id, 'command')}
          >
            Always allow this command
          </button>
        ) : (
          <button
            type="button"
            style={secondaryButtonStyle()}
            title={`Always allow ${approval.toolName} in this workspace`}
            onClick={() => props.onAlwaysAllow(approval.id, 'tool')}
          >
            Always allow {approval.toolName}
          </button>
        )}
      </div>
    </div>
  )
}
