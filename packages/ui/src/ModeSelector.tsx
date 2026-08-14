import { BUILTIN_MODES, findMode } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { Select } from './Select.js'

export interface ModeSelectorProps {
  modeId: string
  disabled: boolean
  onChange: (modeId: string) => void
  /**
   * Junior mode delegates its thinking to the Claude CLI, so without one configured it is an
   * ordinary Code session whose prompt keeps referring to an expert that is not there.
   * Disabled rather than hidden, so the feature is discoverable and says what it needs.
   */
  expertAvailable: boolean
}

export function ModeSelector(props: ModeSelectorProps): ReactElement {
  const mode = findMode(props.modeId)
  return (
    <Select
      compact
      value={mode.id}
      // Switching mid-turn would change the tool set underneath a running loop.
      disabled={props.disabled}
      title={mode.description}
      ariaLabel="Mode"
      onChange={props.onChange}
      options={BUILTIN_MODES.map((option) => ({
        value: option.id,
        label: option.name,
        ...(option.requiresExpert === true && !props.expertAvailable
          ? { disabled: true, detail: 'needs the expert' }
          : {}),
      }))}
    />
  )
}
