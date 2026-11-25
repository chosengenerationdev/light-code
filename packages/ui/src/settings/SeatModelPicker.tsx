import { useEffect, useState, type ReactElement } from 'react'

import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'

import { Select } from '../Select.js'
import { colors, labelStyle, textFieldStyle } from '../theme.js'

/**
 * The model for a seat (a specialist role, the decision model, the reranker, the Auditor, the Anti Hallucinator,
 * suggestions), from the chosen provider's own list - loaded by itself when the provider is chosen. Asked for: "just
 * select the provider and then select the model for that seat based on selected provider, else user have to create many
 * providers". Empty is the profile's own model, so a seat set up before this is unchanged. A model the list does not
 * offer can still be typed: gateways often publish no list (§9).
 */
export function SeatModelPicker(props: {
  transport: Transport
  profileId: string | undefined
  value: string | undefined
  onChange: (model: string | undefined) => void
  label?: string
}): ReactElement | null {
  const { transport, profileId } = props
  const [list, setList] = useState<{ profileId: string; models: string[]; own?: string; warning?: string } | undefined>(undefined)
  const [typed, setTyped] = useState(props.value ?? '')
  useEffect(() => setTyped(props.value ?? ''), [props.value])

  useEffect(() => {
    if (profileId === undefined) return undefined
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'profileModels' && message.profileId === profileId) {
        setList({ profileId, models: message.models, ...(message.model !== undefined ? { own: message.model } : {}), ...(message.warning !== undefined ? { warning: message.warning } : {}) })
      }
    })
    transport.post({ type: 'requestProfileModels', profileId } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport, profileId])

  if (profileId === undefined) return null
  const current = list?.profileId === profileId ? list : undefined
  const models = current?.models ?? []
  const value = props.value ?? ''
  const options = [
    { value: '', label: `The profile's own model${current?.own !== undefined ? ` (${current.own})` : ''}` },
    ...(value !== '' && !models.includes(value) ? [{ value, label: value, detail: 'typed' }] : []),
    ...models.map((id) => ({ value: id, label: id })),
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
      <label style={labelStyle()}>{props.label ?? 'Model'}</label>
      <Select
        value={value}
        ariaLabel={props.label ?? 'Model for this seat'}
        options={options}
        onChange={(chosen) => props.onChange(chosen === '' ? undefined : chosen)}
      />
      <input
        value={typed}
        placeholder={current === undefined ? 'Loading the models…' : 'Or type a model name'}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={() => {
          const next = typed.trim()
          if (next !== value) props.onChange(next === '' ? undefined : next)
        }}
        style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
      />
      {current?.warning !== undefined && models.length === 0 ? <span style={{ color: colors.muted, fontSize: 11 }}>{current.warning} - type the model name instead.</span> : null}
    </div>
  )
}
