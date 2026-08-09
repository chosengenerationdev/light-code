import type { ApprovalDecision, ContextUsage, ImageAttachmentInput } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { ApprovalPrompt, type PendingApproval } from './approval/ApprovalPrompt.js'
import { Composer } from './Composer.js'
import { MessageList, type DisplayMessage } from './MessageList.js'
import { TokenBar } from './TokenBar.js'
import { colors, secondaryButtonStyle } from './theme.js'

export interface ChatProps {
  messages: DisplayMessage[]
  isStreaming: boolean
  error: string | undefined
  pendingApproval: PendingApproval | undefined
  canRollback: boolean
  onSend: (text: string, images: ImageAttachmentInput[]) => void
  onCancel: () => void
  onDecideApproval: (id: string, decision: ApprovalDecision) => void
  onAlwaysAllow: (id: string, scope: 'tool' | 'command') => void
  onRollback: () => void
  usage: ContextUsage | undefined
  supportsVision: boolean
  mentionCandidates: string[]
  onQueryMentions: (query: string) => void
}

export function Chat(props: ChatProps): ReactElement {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <MessageList messages={props.messages} error={props.error} />
        {props.pendingApproval !== undefined && (
          <ApprovalPrompt
            approval={props.pendingApproval}
            onDecide={props.onDecideApproval}
            onAlwaysAllow={props.onAlwaysAllow}
          />
        )}
      </div>
      {props.canRollback && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '6px 10px',
            borderTop: `1px solid ${colors.border}`,
            color: colors.muted,
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          <span>Files were changed this task.</span>
          <button type="button" style={secondaryButtonStyle()} onClick={props.onRollback}>
            Undo all changes
          </button>
        </div>
      )}
      <TokenBar usage={props.usage} />
      <Composer
        isStreaming={props.isStreaming}
        onSend={props.onSend}
        onCancel={props.onCancel}
        supportsVision={props.supportsVision}
        mentionCandidates={props.mentionCandidates}
        onQueryMentions={props.onQueryMentions}
      />
    </div>
  )
}
