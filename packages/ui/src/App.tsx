import type { HostToUiMessage, ProfileInput, ProfileSummary, Transport, UiToHostMessage } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { Chat } from './Chat.js'
import type { DisplayMessage } from './MessageList.js'
import { SettingsPanel } from './settings/SettingsPanel.js'
import { BackIcon, SettingsIcon } from './icons.js'
import { colors, fontFamily, iconButtonStyle, primaryButtonStyle } from './theme.js'

export interface AppProps {
  transport: Transport
}

type View = 'chat' | 'settings'

/** If the last message is still streaming, finalize it (drop the `pending` flag) in place. */
function finalizePendingMessage(messages: DisplayMessage[]): DisplayMessage[] {
  const last = messages[messages.length - 1]
  if (last === undefined || !last.pending) return messages
  return [...messages.slice(0, -1), { role: last.role, content: last.content }]
}

export function App(props: AppProps): ReactElement {
  const [view, setView] = useState<View>('chat')
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>(undefined)
  const [profilesLoaded, setProfilesLoaded] = useState(false)

  useEffect(() => {
    const unsubscribe = props.transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'textChunk') {
        // `message.text` is the full accumulated response so far, not a delta — see
        // protocol.ts. The in-progress assistant message lives directly in `messages`
        // (updated in place via its `pending` flag) rather than in separate state, so
        // there's no hand-off moment between "streaming" and "final" for a bug to hide in.
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          const updated: DisplayMessage = { role: 'assistant', content: message.text, pending: true }
          if (last?.role === 'assistant' && last.pending) {
            return [...prev.slice(0, -1), updated]
          }
          return [...prev, updated]
        })
      } else if (message.type === 'done') {
        setMessages(finalizePendingMessage)
        setIsStreaming(false)
      } else if (message.type === 'error') {
        // A late error must not erase text that already streamed in successfully —
        // finalize whatever arrived, and show the error alongside it, not instead of it.
        setMessages(finalizePendingMessage)
        setError(message.message)
        setIsStreaming(false)
      } else if (message.type === 'profiles') {
        setProfiles(message.profiles)
        setActiveProfileId(message.activeProfileId)
        setProfilesLoaded(true)
      } else if (message.type === 'profileSaved') {
        setView('chat')
      }
    })

    // Fetch once on mount so the fresh-install CTA (or the chat) can render correctly
    // without the user having to open Settings first.
    const outgoing: UiToHostMessage = { type: 'requestProfiles' }
    props.transport.post(outgoing)

    return unsubscribe
  }, [props.transport])

  const openSettings = (): void => {
    const outgoing: UiToHostMessage = { type: 'requestProfiles' }
    props.transport.post(outgoing)
    setView('settings')
  }

  const send = (text: string): void => {
    setError(undefined)
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setIsStreaming(true)
    const outgoing: UiToHostMessage = { type: 'sendMessage', text }
    props.transport.post(outgoing)
  }

  const cancel = (): void => {
    const outgoing: UiToHostMessage = { type: 'cancel' }
    props.transport.post(outgoing)
  }

  const saveProfile = (input: ProfileInput): void => {
    props.transport.post({ type: 'saveProfile', profile: input } satisfies UiToHostMessage)
  }
  const duplicateProfile = (id: string): void => {
    props.transport.post({ type: 'duplicateProfile', id } satisfies UiToHostMessage)
  }
  const deleteProfile = (id: string): void => {
    props.transport.post({ type: 'deleteProfile', id } satisfies UiToHostMessage)
  }
  const setActiveProfile = (id: string): void => {
    props.transport.post({ type: 'setActiveProfile', id } satisfies UiToHostMessage)
  }
  const exportConfig = (): void => {
    props.transport.post({ type: 'exportConfig' } satisfies UiToHostMessage)
  }
  const importConfig = (): void => {
    props.transport.post({ type: 'importConfig' } satisfies UiToHostMessage)
  }

  const hasNoProviders = profilesLoaded && profiles.length === 0

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        boxSizing: 'border-box',
        background: colors.background,
        color: colors.foreground,
        fontFamily,
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <strong>Light Code</strong>
        {view === 'chat' ? (
          <button type="button" aria-label="Settings" title="Settings" style={iconButtonStyle('ghost')} onClick={openSettings}>
            <SettingsIcon />
          </button>
        ) : (
          <button type="button" aria-label="Back" title="Back" style={iconButtonStyle('ghost')} onClick={() => setView('chat')}>
            <BackIcon />
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'settings' ? (
          <SettingsPanel
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSave={saveProfile}
            onDuplicate={duplicateProfile}
            onDelete={deleteProfile}
            onSetActive={setActiveProfile}
            onExport={exportConfig}
            onImport={importConfig}
          />
        ) : hasNoProviders ? (
          <div style={{ padding: 20, textAlign: 'center' }}>
            <p style={{ color: colors.muted }}>No provider configured yet.</p>
            <button type="button" style={primaryButtonStyle(false)} onClick={openSettings}>
              Configure a Provider
            </button>
          </div>
        ) : (
          <Chat messages={messages} isStreaming={isStreaming} error={error} onSend={send} onCancel={cancel} />
        )}
      </div>
    </div>
  )
}
