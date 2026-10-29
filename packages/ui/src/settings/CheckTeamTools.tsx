import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'

import { disabledWhen } from '../disabledWhen.js'
import { colors, secondaryButtonStyle } from '../theme.js'

/**
 * "Check for new team tools" (asked for: the approval window for a colleague's new tool did not show soon
 * enough). Pulls the team's bucket tool folders and the team repository now instead of at the next timer,
 * reloads the tools, and says what came down; anything new appears above the chat for approval as usual.
 * Self-contained: it talks to the host itself, like `DeleteEverywhere`.
 */
export function CheckTeamTools(props: { transport: Transport }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | undefined>(undefined)

  useEffect(
    () =>
      props.transport.onMessage((raw) => {
        const message = raw as HostToUiMessage
        if (message.type === 'teamToolsChecked') {
          setResult({ ok: message.ok, message: message.message })
          setBusy(false)
        } else if (message.type === 'error' && busy) setBusy(false)
      }),
    [props.transport, busy],
  )

  const check = (): void => {
    setResult(undefined)
    setBusy(true)
    props.transport.post({ type: 'checkTeamTools' } satisfies UiToHostMessage)
  }

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        style={secondaryButtonStyle()}
        onClick={check}
        {...disabledWhen([busy, 'Checking the team folders now…'], { enabledTitle: "Pull the team's bucket and repository now, so new tools are offered for approval" })}
      >
        {busy ? 'Checking for new team tools…' : 'Check for new team tools'}
      </button>
      {result !== undefined && (
        <div role="status" style={{ fontSize: 11, marginTop: 4, color: result.ok ? colors.muted : colors.error }}>
          {result.message}
        </div>
      )}
    </div>
  )
}
