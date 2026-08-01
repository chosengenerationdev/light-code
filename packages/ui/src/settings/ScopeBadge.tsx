import type { ReactElement } from 'react'
import { badgeStyle } from '../theme.js'

export interface ScopeBadgeProps {
  scope: 'user' | 'workspace'
  /** Shown when a workspace tried to set a user-scope-only value and was ignored — invariant 5. */
  ignored?: boolean
}

export function ScopeBadge(props: ScopeBadgeProps): ReactElement {
  if (props.ignored === true) {
    return <span style={badgeStyle('warning')}>Ignored (user-scope only)</span>
  }
  return <span style={badgeStyle('neutral')}>{props.scope === 'user' ? 'User' : 'Workspace'}</span>
}
