import type { ApprovalDecision, ContextUsage, ImageAttachmentInput, ProfileSummary } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { ApprovalPrompt, type PendingApproval } from './approval/ApprovalPrompt.js'
import { Composer } from './Composer.js'
import { MessageList, type DisplayMessage } from './MessageList.js'
import { TokenBar } from './TokenBar.js'
import { WorkingIndicator } from './WorkingIndicator.js'
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
  profiles: ProfileSummary[]
  activeProfileId: string | undefined
  onSelectProfile: (id: string) => void
  expertEnabled: boolean
  queued: string[]
  onUnqueue: (index: number) => void
}

export function Chat(props: ChatProps): ReactElement {
  /**
   * What to say the model is doing, or undefined when it is not working.
   *
   * Suppressed once text is actually streaming: the words arriving are their own evidence
   * of progress, and an indicator underneath them is just clutter. It stays up while a
   * tool runs, because that is the other stretch with nothing to look at.
   */
  const workingLabel = ((): string | undefined => {
    if (!props.isStreaming) return undefined
    // An approval prompt is on screen and waiting for the user — nothing is working.
    if (props.pendingApproval !== undefined) return undefined

    const last = props.messages[props.messages.length - 1]
    if (last?.kind === 'tool' && last.toolCall.result === undefined) {
      return `Running ${last.toolCall.name}`
    }
    if (last?.kind === 'text' && last.role === 'assistant' && last.pending === true) return undefined
    if (last?.kind === 'reasoning' && last.pending === true) return undefined
    return 'Thinking'
  })()

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <MessageList messages={props.messages} error={props.error} />
        {workingLabel !== undefined && <WorkingIndicator label={workingLabel} />}
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
        profiles={props.profiles}
        activeProfileId={props.activeProfileId}
        onSelectProfile={props.onSelectProfile}
        expertEnabled={props.expertEnabled}
        queued={props.queued}
        onUnqueue={props.onUnqueue}
      />
    </div>
  )
}
