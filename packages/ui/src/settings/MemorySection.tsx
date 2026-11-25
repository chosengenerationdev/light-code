import { useEffect, useState, type ReactElement } from 'react'

import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'

import { colors, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { disabledWhen } from '../disabledWhen.js'
import { Panel } from './Panel.js'

type MemoryMessage = Extract<HostToUiMessage, { type: 'codebaseMemory' }>

/**
 * Settings -> Project -> Memory: the codebase's remembered guidance (`memory/store.ts`), self-contained over the
 * transport. Asked for: a memory of the user's short corrections and important guidance, kept by the Anti Hallucinator
 * and used to redirect the agent later. Every entry can be read, edited and removed here, and the user can add their own.
 */
export function MemorySection(props: { transport: Transport }): ReactElement | null {
  const { transport } = props
  const [state, setState] = useState<MemoryMessage | undefined>(undefined)
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | undefined>(undefined)

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'codebaseMemory') setState(message)
    })
    transport.post({ type: 'requestCodebaseMemory' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])

  if (state === undefined || !state.available) return null
  const post = (message: UiToHostMessage): void => transport.post(message)
  const when = (at: number): string => new Date(at).toLocaleDateString()

  return (
    <div style={{ padding: '0 12px 12px' }}>
      <Panel id="project.memory" title="Memory" summary={`${String(state.entries.length)} remembered${state.enabled ? '' : ' (off)'}`}>
        <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 8px' }}>
          Short corrections and guidance you gave the agent, kept for this codebase so they apply in every later chat. The Anti Hallucinator adds
          them as you work, and reminds the agent when it is about to go against one. Kept on this computer, outside the repository.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" checked={state.enabled} onChange={(event) => post({ type: 'setCodebaseMemoryEnabled', value: event.target.checked })} />
          Use the memory: give it to the agent, and let the Anti Hallucinator add to it
        </label>
        {state.enabled && !state.guardOn && (
          <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
            The Anti Hallucinator is off (above), so nothing is added by itself - what is here, and what you add, is still given to the agent.
          </p>
        )}
        {state.entries.length === 0 ? (
          <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 8px' }}>Nothing remembered yet.</p>
        ) : (
          <div data-testid="memory-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {state.entries.map((entry) => (
              <div key={entry.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 4, padding: 6, fontSize: 12 }}>
                {editing?.id === entry.id ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={editing.text} onChange={(event) => setEditing({ id: entry.id, text: event.target.value })} style={{ ...textFieldStyle(), flex: 1 }} />
                    <button
                      type="button"
                      style={primaryButtonStyle(editing.text.trim().length === 0)}
                      {...disabledWhen([editing.text.trim().length === 0, 'Type the guidance first.'])}
                      onClick={() => {
                        post({ type: 'editCodebaseMemory', id: entry.id, text: editing.text })
                        setEditing(undefined)
                      }}
                    >
                      Save
                    </button>
                    <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(undefined)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <span style={{ flex: 1 }}>{entry.text}</span>
                    <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing({ id: entry.id, text: entry.text })}>
                      Edit
                    </button>
                    <button type="button" style={secondaryButtonStyle()} onClick={() => post({ type: 'deleteCodebaseMemory', id: entry.id })}>
                      Remove
                    </button>
                  </div>
                )}
                <div style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
                  {entry.by === 'you' ? 'Added by you' : 'Kept by the Anti Hallucinator'} on {when(entry.at)}
                  {entry.uses > 0 ? ` · redirected the agent ${String(entry.uses)} time${entry.uses === 1 ? '' : 's'}` : ''}
                  {entry.from !== undefined ? ` · from: "${entry.from.length > 120 ? `${entry.from.slice(0, 120)}…` : entry.from}"` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={adding}
            placeholder="Add guidance, e.g. Always run the tests with -x before saying they pass"
            onChange={(event) => setAdding(event.target.value)}
            style={{ ...textFieldStyle(), flex: 1 }}
          />
          <button
            type="button"
            style={primaryButtonStyle(adding.trim().length < 4)}
            {...disabledWhen([adding.trim().length < 4, 'Type the guidance first.'])}
            onClick={() => {
              post({ type: 'addCodebaseMemory', text: adding.trim() })
              setAdding('')
            }}
          >
            Remember
          </button>
        </div>
      </Panel>
    </div>
  )
}
