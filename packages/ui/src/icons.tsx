import type { ReactElement } from 'react'

interface IconProps {
  size?: number
}

export function SendIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M1.5 1.5 L14.5 8 L1.5 14.5 L4 8 Z" />
    </svg>
  )
}

export function StopIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
    </svg>
  )
}

export function BackIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 3 L5 8 L10 13" />
    </svg>
  )
}

export function SettingsIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="2" y1="4" x2="14" y2="4" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <line x1="2" y1="12" x2="14" y2="12" />
      <circle cx="6" cy="4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}
