import type { CSSProperties } from 'react'

/**
 * VS Code injects `--vscode-*` custom properties into every webview reflecting the
 * user's active theme. Styling against these (rather than a fixed palette) is what
 * makes the UI look native and stay correct across dark/light/high-contrast themes.
 * React's `style` prop sets these via the CSSOM, not the `style` attribute, so this
 * needs no `style-src` CSP allowance — see apps/vscode/src/webview/chatViewProvider.ts.
 */
export const colors = {
  background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
  foreground: 'var(--vscode-foreground)',
  muted: 'var(--vscode-descriptionForeground)',
  border: 'var(--vscode-widget-border, var(--vscode-panel-border))',
  inputBackground: 'var(--vscode-input-background)',
  inputForeground: 'var(--vscode-input-foreground)',
  inputBorder: 'var(--vscode-input-border, var(--vscode-widget-border))',
  buttonBackground: 'var(--vscode-button-background)',
  buttonForeground: 'var(--vscode-button-foreground)',
  buttonHoverBackground: 'var(--vscode-button-hoverBackground)',
  secondaryButtonBackground: 'var(--vscode-button-secondaryBackground, var(--vscode-input-background))',
  secondaryButtonForeground: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
  secondaryButtonHoverBackground: 'var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground))',
  hoverBackground: 'var(--vscode-toolbar-hoverBackground)',
  error: 'var(--vscode-errorForeground)',
  focusBorder: 'var(--vscode-focusBorder)',
  assistantBubble: 'var(--vscode-editor-inactiveSelectionBackground, var(--vscode-input-background))',
} as const

export const fontFamily = 'var(--vscode-font-family, sans-serif)'

export function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    background: colors.buttonBackground,
    color: colors.buttonForeground,
    border: 'none',
    borderRadius: 2,
    padding: '4px 12px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    fontFamily,
  }
}

export function iconButtonStyle(kind: 'primary' | 'secondary' | 'ghost', disabled = false): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    borderRadius: 4,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    flexShrink: 0,
  }
  if (kind === 'primary') {
    return { ...base, background: colors.buttonBackground, color: colors.buttonForeground, border: 'none' }
  }
  if (kind === 'secondary') {
    return {
      ...base,
      background: colors.secondaryButtonBackground,
      color: colors.secondaryButtonForeground,
      border: `1px solid ${colors.border}`,
    }
  }
  return { ...base, background: 'transparent', color: colors.foreground, border: 'none' }
}

export function textFieldStyle(): CSSProperties {
  return {
    background: colors.inputBackground,
    color: colors.inputForeground,
    border: `1px solid ${colors.inputBorder}`,
    borderRadius: 2,
    padding: '6px 8px',
    fontFamily,
    fontSize: 13,
    width: '100%',
    boxSizing: 'border-box',
  }
}

/**
 * Dropdowns need their own style, and `<option>` needs styling separately.
 *
 * A `<select>` renders its popup with the platform's native list, which on Windows and
 * Linux is white regardless of what the control itself looks like. Styling only the select
 * gives a correctly-dark closed control that flashes a white list when opened. Chromium —
 * which is what a VS Code webview is — does honour `background`/`color` on `<option>`,
 * so `optionStyle()` must be applied to every option for the popup to match the theme.
 *
 * (macOS draws the popup with the system appearance and ignores both; there is nothing to
 * be done about that, and it follows the OS dark mode anyway.)
 */
export function selectStyle(compact = false): CSSProperties {
  return {
    background: colors.inputBackground,
    color: colors.inputForeground,
    border: `1px solid ${colors.inputBorder}`,
    borderRadius: 2,
    padding: compact ? '2px 4px' : '6px 8px',
    fontFamily,
    fontSize: compact ? 11 : 13,
    cursor: 'pointer',
  }
}

export function optionStyle(): CSSProperties {
  return { background: colors.inputBackground, color: colors.inputForeground }
}

export function labelStyle(): CSSProperties {
  return {
    color: colors.muted,
    fontSize: 12,
    display: 'block',
    marginBottom: 4,
  }
}

export function secondaryButtonStyle(): CSSProperties {
  return {
    background: colors.secondaryButtonBackground,
    color: colors.secondaryButtonForeground,
    border: `1px solid ${colors.border}`,
    borderRadius: 2,
    padding: '4px 10px',
    cursor: 'pointer',
    fontFamily,
    fontSize: 12,
  }
}

export function fieldErrorStyle(): CSSProperties {
  return {
    color: colors.error,
    fontSize: 11,
    display: 'block',
    marginTop: 2,
  }
}

export function badgeStyle(kind: 'neutral' | 'warning' = 'neutral'): CSSProperties {
  return {
    display: 'inline-block',
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    color: kind === 'warning' ? colors.error : colors.muted,
  }
}
