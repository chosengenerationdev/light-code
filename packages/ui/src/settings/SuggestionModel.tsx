import { useEffect, useState, type ReactElement } from 'react'

import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'

import { Select } from '../Select.js'
import { colors, labelStyle } from '../theme.js'
import { SeatModelPicker } from './SeatModelPicker.js'

type Settings = Extract<HostToUiMessage, { type: 'completionSettings' }>

/**
 * Settings -> Appearance -> Suggestions while typing: which model suggests, and how the last suggestion went. Reported:
 * no suggestion ever appeared with a large chat model that took longer than the time limit to start answering - and
 * nothing on screen said so. A small, fast model can be chosen for suggestions alone.
 */
export function SuggestionModel(props: { transport: Transport }): ReactElement | null {
  const { transport } = props
  const [state, setState] = useState<Settings | undefined>(undefined)

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'completionSettings') setState(message)
    })
    const ask = (): void => transport.post({ type: 'requestCompletionSettings' } satisfies UiToHostMessage)
    ask()
    // How the last suggestion went changes while typing elsewhere; asked again now and then while this is open.
    const timer = setInterval(ask, 5_000)
    return () => {
      clearInterval(timer)
      unsubscribe()
    }
  }, [transport])

  if (state === undefined) return null
  return (
    <div style={{ marginTop: 10, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={labelStyle()}>Model for suggestions</label>
      <Select
        value={state.profileId ?? ''}
        ariaLabel="Model for suggestions"
        options={[
          { value: '', label: `The chat's model${state.chatModel !== undefined ? ` (${state.chatModel})` : ''}` },
          ...state.profiles.map((profile) => ({ value: profile.id, label: profile.label, detail: profile.model })),
        ]}
        onChange={(value) => transport.post({ type: 'setCompletionProfile', ...(value !== '' ? { profileId: value } : {}) } satisfies UiToHostMessage)}
      />
      <SeatModelPicker
        transport={transport}
        profileId={state.profileId ?? state.chatProfileId}
        value={state.model}
        onChange={(model) => transport.post({ type: 'setCompletionProfile', ...(state.profileId !== undefined ? { profileId: state.profileId } : {}), ...(model !== undefined ? { model } : {}) } satisfies UiToHostMessage)}
        label="Its model"
      />
      <span style={{ color: colors.muted, fontSize: 11 }}>
        A suggestion must start within 12 seconds. A large model is often too slow; a small, fast one (a Flash or mini model) suits this best.
      </span>
      {state.lastProblem !== undefined ? (
        <span data-testid="suggestion-problem" style={{ color: colors.error, fontSize: 11 }}>
          Last suggestion: {state.lastProblem}
        </span>
      ) : state.lastOk !== undefined ? (
        <span style={{ color: colors.muted, fontSize: 11 }}>
          Last suggestion: from {state.lastOk.model} in {(state.lastOk.ms / 1000).toFixed(1)} s.
        </span>
      ) : null}
    </div>
  )
}
