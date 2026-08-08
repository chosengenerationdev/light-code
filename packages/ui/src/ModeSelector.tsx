import { BUILTIN_MODES, findMode } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { colors, fontFamily } from './theme.js'

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
      style={{
        background: colors.inputBackground,
        color: colors.inputForeground,
        border: `1px solid ${colors.inputBorder}`,
        borderRadius: 2,
        padding: '2px 4px',
        fontFamily,
        fontSize: 11,
        cursor: props.disabled ? 'default' : 'pointer',
      }}
    >
      {BUILTIN_MODES.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  )
}
