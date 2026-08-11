import { BUILTIN_MODES, findMode } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { optionStyle, selectStyle } from './theme.js'

export interface ModeSelectorProps {
  modeId: string
  disabled: boolean
  onChange: (modeId: string) => void
}

export function ModeSelector(props: ModeSelectorProps): ReactElement {
  const mode = findMode(props.modeId)
  return (
    <select
      value={mode.id}
      // Switching mid-turn would change the tool set underneath a running loop.
      disabled={props.disabled}
      title={mode.description}
      onChange={(event) => props.onChange(event.target.value)}
      style={{ ...selectStyle(true), cursor: props.disabled ? 'default' : 'pointer' }}
    >
      {BUILTIN_MODES.map((option) => (
        <option key={option.id} value={option.id} style={optionStyle()}>
          {option.name}
        </option>
      ))}
    </select>
  )
}
