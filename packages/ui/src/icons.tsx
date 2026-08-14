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

/** The assistant's own voice, on every message it authors. */
export function AgentIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="3" y="5.5" width="10" height="7.5" rx="2" />
      <line x1="8" y1="2" x2="8" y2="5.5" />
      <circle cx="8" cy="1.6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="6" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function UserIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="5" r="2.6" />
      <path d="M2.8 14 a5.2 5.2 0 0 1 10.4 0" />
    </svg>
  )
}

/**
 * Marks work the expert shaped: the consultation itself, and anything the model did after
 * acting on its advice. A distinct mark rather than a colour, so it survives high-contrast
 * themes and reads at a glance in a long transcript.
 */
export function ExpertIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M8 1.6 l1.7 3.6 3.9 .5 -2.9 2.7 .8 3.9 L8 10.4 l-3.5 1.9 .8 -3.9 -2.9 -2.7 3.9 -.5 Z" />
    </svg>
  )
}

export function CheckIcon({ size = 14 }: IconProps): ReactElement {
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
      <path d="M3 8.5 L6.5 12 L13 4.5" />
    </svg>
  )
}

export function CrossIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  )
}

export function SpinnerIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" opacity="0.25" />
      <path d="M8 2.5 a5.5 5.5 0 0 1 5.5 5.5" strokeLinecap="round" />
    </svg>
  )
}

export function TrashIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 4.5 h10" />
      <path d="M6.5 4.5 V3 h3 v1.5" />
      <path d="M4.3 4.5 l.6 8.2 h6.2 l.6 -8.2" />
    </svg>
  )
}

export function CopyIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5 V4 a1.5 1.5 0 0 0 -1.5 -1.5 H4 A1.5 1.5 0 0 0 2.5 4 v5 A1.5 1.5 0 0 0 4 10.5 h1.5" />
    </svg>
  )
}

export function EditIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.2 2.3 l2.5 2.5 -8 8 -3.2 .7 .7 -3.2 Z" />
    </svg>
  )
}

export function AttachIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 4 L5 8.5 a2.1 2.1 0 0 0 3 3 L12.5 7 a3.5 3.5 0 0 0-5-5 L3.5 6" />
    </svg>
  )
}

export function HistoryIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" />
      <path d="M2 2.5 V5.5 H5" />
      <path d="M8 5 V8.4 L10.3 9.8" />
    </svg>
  )
}

export function NewTaskIcon({ size = 16 }: IconProps): ReactElement {
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
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
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

/**
 * The disclosure chevron. Always points right; callers rotate it with a CSS transform so
 * expanding animates instead of swapping one glyph for another.
 *
 * Replaces the ▸/▾ text characters that were here before. Those are font-dependent — they
 * render at a different size and baseline in every theme — and they cannot be transitioned.
 */
export function ChevronIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 L10.5 8 L6 12.5" />
    </svg>
  )
}

/** Roll back the workspace to the pre-edit checkpoint. */
export function UndoIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8a5 5 0 1 1 1.6 3.7" />
      <path d="M2.5 4.5 L3 8 L6.5 7.6" />
    </svg>
  )
}

/** Appearance / accent colour. */
export function PaletteIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M8 1.6a6.4 6.4 0 0 0 0 12.8c1 0 1.4-.7 1.1-1.4-.4-.9.2-1.7 1.2-1.7h1.1A3 3 0 0 0 14.4 8 6.4 6.4 0 0 0 8 1.6Z" />
      <circle cx="5.2" cy="6.4" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="8" cy="4.6" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="10.9" cy="6.2" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  )
}
