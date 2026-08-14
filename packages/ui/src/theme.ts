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

  /*
   * The accent. Set on the document root by `applyAccent` (styles.ts) rather than hardcoded,
   * so the user's chosen colour flows everywhere at once — including into rules in the
   * stylesheet, which cannot read a JS constant.
   *
   * The fallbacks matter: they are what renders during the first paint, before config has
   * arrived over the bridge. Without them the UI flashes unstyled purple-less grey.
   */
  accent: 'var(--lc-accent, #A855F7)',
  accentDeep: 'var(--lc-accent-deep, #6821A0)',
  accentContrast: 'var(--lc-accent-contrast, #ffffff)',
  accentSoft: 'var(--lc-accent-a12, rgba(168, 85, 247, 0.12))',
  accentRing: 'var(--lc-accent-a35, rgba(168, 85, 247, 0.35))',
  /** The logo's own gradient, reproduced from whatever accent is active. */
  accentGradient: 'linear-gradient(135deg, var(--lc-accent-deep, #6821A0), var(--lc-accent, #A855F7))',
} as const

export const fontFamily = 'var(--vscode-font-family, sans-serif)'

/**
 * Classes from `styles.ts`, applied alongside inline styles.
 *
 * Inline styles carry everything structural so the UI survives without the stylesheet;
 * these carry hover, press and focus, which cannot be expressed per-element.
 */
export const cls = {
  button: 'lc-btn',
  accentButton: 'lc-btn lc-btn-accent',
  input: 'lc-input',
  scroll: 'lc-scroll',
  panel: 'lc-panel',
  tab: 'lc-tab',
  swatch: 'lc-swatch',
} as const

export function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? colors.secondaryButtonBackground : colors.accentGradient,
    color: disabled ? colors.muted : colors.accentContrast,
    border: 'none',
    borderRadius: 6,
    padding: '5px 14px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    fontFamily,
    fontWeight: 500,
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
    // Rounder than the old 4px: an icon button reads as a target rather than a box, and it
    // is what makes the press animation land as "soft" rather than as a shrinking rectangle.
    borderRadius: 8,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    flexShrink: 0,
  }
  if (kind === 'primary') {
    return { ...base, background: colors.accentGradient, color: colors.accentContrast, border: 'none' }
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
