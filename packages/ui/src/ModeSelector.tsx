import { BUILTIN_MODES, findMode } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { Select } from './Select.js'

export interface ModeSelectorProps {
  modeId: string
  disabled: boolean
  onChange: (modeId: string) => void
  /**
   * Whether any specialist is assigned (Settings → Agents) - any role, not only the expert. Agent team mode
   * consults whoever is there, and since its strategies (0.201.0) a tester and a programmer are a team on their
   * own; it used to wait for the expert, which the user reported no longer made sense.
   * Disabled rather than hidden, so the mode is discoverable and says what it needs.
   */
  teamAvailable: boolean
}

export function ModeSelector(props: ModeSelectorProps): ReactElement {
  const mode = findMode(props.modeId)
  return (
    <Select
      compact
      value={mode.id}
      // Switching mid-turn would change the tool set underneath a running loop.
      disabled={props.disabled}
      title={props.disabled ? 'The mode cannot change while a reply is running: it would swap the tools under it. Wait for it to finish, or press Stop.' : mode.description}
      ariaLabel="Mode"
      onChange={props.onChange}
      options={BUILTIN_MODES.map((option) => ({
        value: option.id,
        label: option.name,
        ...(option.requiresExpert === true && !props.teamAvailable
          ? { disabled: true, detail: 'assign a specialist in Settings → Agents' }
          : {}),
      }))}
    />
  )
}
