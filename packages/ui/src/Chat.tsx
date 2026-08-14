import type { ApprovalDecision, ContextUsage, ImageAttachmentInput, ProfileSummary } from '@light-code/core/browser'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ApprovalPrompt, type PendingApproval } from './approval/ApprovalPrompt.js'
import { Composer } from './Composer.js'
import { MessageList, type DisplayMessage } from './MessageList.js'
import { PinnedPrompt } from './PinnedPrompt.js'
import { ExpertSpend } from './ExpertSpend.js'
import { TokenBar } from './TokenBar.js'
import { WorkingIndicator } from './WorkingIndicator.js'
import { UndoIcon } from './icons.js'
import { cls, colors, iconButtonStyle } from './theme.js'

export interface ChatProps {
  messages: DisplayMessage[]
  isStreaming: boolean
  error: string | undefined
  pendingApproval: PendingApproval | undefined
  canRollback: boolean
  onSend: (text: string, images: ImageAttachmentInput[]) => void
  onCancel: () => void
  onDecideApproval: (id: string, decision: ApprovalDecision) => void
  onAlwaysAllow: (id: string, scope: 'tool' | 'command' | 'folder') => void
  onRollback: () => void
  usage: ContextUsage | undefined
  expertSpend: { usd: number; consultations: number; unpriced: number }
  supportsVision: boolean
  mentionCandidates: string[]
  onQueryMentions: (query: string) => void
  profiles: ProfileSummary[]
  activeProfileId: string | undefined
  onSelectProfile: (id: string) => void
  expertEnabled: boolean
  queued: string[]
  onUnqueue: (index: number) => void
  searchConnections: { id: string; label: string }[]
  activeSearchId: string | undefined
  onSelectSearch: (id: string | undefined) => void
}

export function Chat(props: ChatProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [promptOutOfView, setPromptOutOfView] = useState(false)

  /** The newest thing the user asked, for the pin. */
  const latestPrompt = (() => {
    for (let index = props.messages.length - 1; index >= 0; index--) {
      const message = props.messages[index]
      if (message?.kind === 'text' && message.role === 'user') return message.content
    }
    return undefined
  })()

  /*
   * Watches whether the newest user message is still on screen.
   *
   * An observer rather than scroll arithmetic: `scroll` fires continuously and would need
   * measuring on every frame, while this reports only the transition that matters. Scoped to
   * the scroll container as root, so it answers "visible in the transcript" rather than
   * "visible in the window", which differ the moment the panel is short.
   *
   * Re-established whenever the message list changes, because the marked element is a
   * different node after each turn.
   */
  useEffect(() => {
    const root = scrollRef.current
    const target = root?.querySelector('[data-lc-latest-prompt]')
    if (root === null || target === null || target === undefined) {
      setPromptOutOfView(false)
      return
    }
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry !== undefined) setPromptOutOfView(!entry.isIntersecting)
      },
      { root, threshold: 0 },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [props.messages])

  const revealPrompt = (): void => {
    scrollRef.current?.querySelector('[data-lc-latest-prompt]')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  /**
   * What to say the model is doing, or undefined when it is not working.
   *
   * Suppressed once text is actually streaming: the words arriving are their own evidence
   * of progress, and an indicator underneath them is just clutter. It stays up while a
   * tool runs, because that is the other stretch with nothing to look at.
   */
  const lastCall = props.messages[props.messages.length - 1]
  const consulting = lastCall?.kind === 'tool' && lastCall.toolCall.name === 'ask_expert' && lastCall.toolCall.result === undefined

  const workingLabel = ((): string | undefined => {
    if (!props.isStreaming) return undefined
    // An approval prompt is on screen and waiting for the user — nothing is working.
    if (props.pendingApproval !== undefined) return undefined

    const last = props.messages[props.messages.length - 1]
    if (last?.kind === 'tool' && last.toolCall.result === undefined) {
      // Named rather than generic: a consultation can take half a minute, and "Running
      // ask_expert" does not tell you that something else is doing the thinking.
      return consulting ? 'Consulting the expert' : `Running ${last.toolCall.name}`
    }
    if (last?.kind === 'text' && last.role === 'assistant' && last.pending === true) return undefined
    if (last?.kind === 'reasoning' && last.pending === true) return undefined
    return 'Thinking'
  })()

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/*
        Only once the real message has scrolled away. Rendering it unconditionally would print
        the same sentence twice whenever the conversation still fits, which is most of them.
      */}
      {promptOutOfView && latestPrompt !== undefined && <PinnedPrompt text={latestPrompt} onReveal={revealPrompt} />}
      <div
        ref={scrollRef}
        className="lc-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollBehavior: 'smooth' }}
      >
        <MessageList messages={props.messages} error={props.error} />
        {workingLabel !== undefined && (
          <WorkingIndicator label={workingLabel} variant={consulting ? 'expert' : 'default'} />
        )}
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
          {/* Icon plus tooltip, like the rest of the chrome. The tooltip is deliberately
              explicit about scope — "Undo" alone would not say it reverts the whole task. */}
          <button
            type="button"
            className={cls.button}
            title="Undo all changes made during this task"
            aria-label="Undo all changes made during this task"
            style={iconButtonStyle('secondary')}
            onClick={props.onRollback}
          >
            <UndoIcon size={14} />
          </button>
        </div>
      )}
      <ExpertSpend {...props.expertSpend} />
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
        searchConnections={props.searchConnections}
        activeSearchId={props.activeSearchId}
        onSelectSearch={props.onSelectSearch}
      />
    </div>
  )
}
