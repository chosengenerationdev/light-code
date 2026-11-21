import type { ReactElement } from 'react'

import { colors, secondaryButtonStyle } from './theme.js'

export interface DecisionRoute {
  role?: string | undefined
  name?: string | undefined
  probability?: number | undefined
  note?: string | undefined
}

/**
 * Where the decision model sent the message, above the message box: "Sent to Tester · 0.91" with a way to take it
 * back. Asked for as part of D3 in Agent team mode - a route is shown, never hidden. "Answer it yourself" is an
 * ordinary message joining the running turn, so it needs nothing new from the loop.
 */
export function DecisionRouteNote(props: {
  route: DecisionRoute | undefined
  busy: boolean
  onAnswerYourself: (role: string) => void
  onDismiss: () => void
}): ReactElement | null {
  const route = props.route
  if (route === undefined || (route.role === undefined && route.note === undefined)) return null
  return (
    <div
      data-testid="decision-route"
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', fontSize: 11, color: colors.muted }}
    >
      {route.role !== undefined ? (
        <span title="Agent team: the decision model picked this specialist. The main assistant consults it with the usual approvals.">
          Sent to <strong style={{ color: colors.foreground }}>{route.name ?? route.role}</strong>
          {route.probability !== undefined ? ` · ${route.probability.toFixed(2)}` : ''} by the decision model
        </span>
      ) : (
        <span>{route.note}</span>
      )}
      <span style={{ flex: 1 }} />
      {route.role !== undefined && props.busy && (
        <button type="button" style={{ ...secondaryButtonStyle(), fontSize: 11, padding: '1px 8px' }} title="Tell the main assistant to answer this itself, without the specialist." onClick={() => props.onAnswerYourself(route.role as string)}>
          Answer it yourself
        </button>
      )}
      <button type="button" style={{ ...secondaryButtonStyle(), fontSize: 11, padding: '1px 8px' }} title="Hide this note." onClick={props.onDismiss}>
        Hide
      </button>
    </div>
  )
}
