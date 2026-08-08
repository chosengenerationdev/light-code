import type { TaskListEntry } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { colors, fontFamily, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'

export interface HistoryListProps {
  tasks: TaskListEntry[]
  activeTaskId: string | undefined
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
}

/** Relative for anything recent, absolute once "3 days ago" stops being useful. */
function formatWhen(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days <= 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export function HistoryList(props: HistoryListProps): ReactElement {
  // Deletion is irreversible and also removes spilled tool results, so it confirms in
  // place rather than firing on a single click next to "Open".
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined)

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: colors.foreground }}>History</h3>
        <button type="button" style={{ ...primaryButtonStyle(false), marginLeft: 'auto' }} onClick={props.onNew}>
          New task
        </button>
      </div>

      {props.tasks.length === 0 && (
        <p style={{ color: colors.muted, fontFamily }}>
          No past tasks in this workspace yet. Conversations are saved automatically as you go.
        </p>
      )}

      {props.tasks.map((task) => {
        const isActive = task.id === props.activeTaskId
        const isConfirming = task.id === confirmingId
        return (
          <div
            key={task.id}
            style={{
              padding: 10,
              marginBottom: 8,
              borderRadius: 4,
              border: `1px solid ${isActive ? colors.focusBorder : colors.border}`,
              background: isActive ? colors.assistantBubble : 'transparent',
            }}
          >
            <div style={{ color: colors.foreground, marginBottom: 4, wordBreak: 'break-word' }}>{task.title}</div>
            <div style={{ color: colors.muted, fontSize: 11, marginBottom: 8 }}>
              {formatWhen(task.updatedAt)} · {task.messageCount} message{task.messageCount === 1 ? '' : 's'}
              {isActive ? ' · current' : ''}
            </div>

            {isConfirming ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: colors.muted, fontSize: 11 }}>Delete this task and its saved output?</span>
                <button
                  type="button"
                  style={{ ...secondaryButtonStyle(), color: colors.error }}
                  onClick={() => {
                    setConfirmingId(undefined)
                    props.onDelete(task.id)
                  }}
                >
                  Delete
                </button>
                <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirmingId(undefined)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                {!isActive && (
                  <button type="button" style={secondaryButtonStyle()} onClick={() => props.onOpen(task.id)}>
                    Open
                  </button>
                )}
                <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirmingId(task.id)}>
                  Delete
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
