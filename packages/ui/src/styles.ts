/**
 * The one stylesheet, plus the accent system.
 *
 * ## Why this is a constructable stylesheet and not a `<style>` tag
 *
 * The webview runs under `default-src 'none'` with **no `style-src` entry at all** — see
 * `apps/vscode/src/webview/chatViewProvider.ts`. That has held so far because React's `style`
 * prop writes through the CSSOM rather than emitting a `style=""` attribute, and CSP does not
 * govern the CSSOM.
 *
 * Hover states, `:active` presses, focus rings and `@keyframes` cannot be expressed that way —
 * they are not properties of one element. A `<style>` element would need `style-src`, which
 * means loosening the tightest directive in the product for cosmetics.
 *
 * `new CSSStyleSheet()` + `document.adoptedStyleSheets` is the way out: it is CSSOM, exactly
 * like the `style` prop, so it is **not subject to `style-src`** and the CSP stays untouched.
 * Chromium has supported it since 73 and a VS Code webview is Chromium, so this is not a
 * gamble. If it is ever unavailable the UI keeps working — every layout-critical rule still
 * lives in inline styles, and what is lost is animation, not usability.
 *
 * **Do not "simplify" this into a `<style>` tag or a bundled `.css` import.** Either one
 * reintroduces the `style-src` allowance this exists to avoid.
 */

/**
 * The default accent.
 *
 * Green rather than the logo's purple, by explicit request. The logo keeps its own
 * indigo-to-purple gradient; the two are allowed to differ, and purple remains one press
 * away in the preset row.
 *
 * Worth knowing when changing this: green is light enough (luminance 0.42) that
 * `contrastFor` flips bubble and button text to near-black. That is correct, and it is why
 * the text colour is computed rather than assumed to be white.
 */
export const DEFAULT_ACCENT = '#22C55E'

export interface AccentPreset {
  id: string
  label: string
  value: string
}

/**
 * Offered as swatches. The default leads, and the rest span the wheel so anyone who dislikes
 * it has a real choice rather than three shades of the same thing. Purple is kept prominent
 * because it is still the logo's colour.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'green', label: 'Green', value: DEFAULT_ACCENT },
  { id: 'purple', label: 'Purple', value: '#A855F7' },
  { id: 'indigo', label: 'Indigo', value: '#6366F1' },
  { id: 'blue', label: 'Blue', value: '#3B82F6' },
  { id: 'teal', label: 'Teal', value: '#14B8A6' },
  { id: 'amber', label: 'Amber', value: '#F59E0B' },
  { id: 'rose', label: 'Rose', value: '#F43F5E' },
  { id: 'graphite', label: 'Graphite', value: '#64748B' },
]

/**
 * The expert's default: a coral-orange evoking Claude, whose CLI answers these.
 *
 * Deliberately not derived from the accent — see `applyExpert`.
 */
export const DEFAULT_EXPERT = '#D97757'

/**
 * Offered for the expert. Warm tones lead, since the point is to read as "not the product's
 * colour" and the accent defaults to green — but the full range is here because someone
 * running an amber accent needs somewhere else to go.
 */
export const EXPERT_PRESETS: readonly AccentPreset[] = [
  { id: 'coral', label: 'Coral', value: DEFAULT_EXPERT },
  { id: 'orange', label: 'Orange', value: '#F97316' },
  { id: 'amber', label: 'Amber', value: '#F59E0B' },
  { id: 'rose', label: 'Rose', value: '#F43F5E' },
  { id: 'purple', label: 'Purple', value: '#A855F7' },
  { id: 'blue', label: 'Blue', value: '#3B82F6' },
  { id: 'teal', label: 'Teal', value: '#14B8A6' },
  { id: 'graphite', label: 'Graphite', value: '#64748B' },
]

interface Rgb {
  r: number
  g: number
  b: number
}

/** Accepts `#rgb` and `#rrggbb`. Returns undefined for anything else, so bad input falls back. */
export function parseHex(hex: string): Rgb | undefined {
  const value = hex.trim().replace(/^#/, '')
  const full = value.length === 3 ? value.replace(/./g, (character) => character + character) : value
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return undefined
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

export function isValidAccent(hex: string): boolean {
  return parseHex(hex) !== undefined
}

function toHex({ r, g, b }: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** `amount` < 1 darkens, > 1 lightens. Used to derive the gradient's deep end. */
function shade(rgb: Rgb, amount: number): Rgb {
  if (amount <= 1) return { r: rgb.r * amount, g: rgb.g * amount, b: rgb.b * amount }
  return {
    r: rgb.r + (255 - rgb.r) * (amount - 1),
    g: rgb.g + (255 - rgb.g) * (amount - 1),
    b: rgb.b + (255 - rgb.b) * (amount - 1),
  }
}

/**
 * WCAG relative luminance, used to decide whether text on the accent is black or white.
 *
 * Necessary because the accent is user-chosen: hardcoding white would make amber and teal
 * bubbles unreadable, and that is exactly the sort of thing a colour picker invites.
 */
function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * Text colour for a filled accent surface — a user bubble, the send button, a swatch tick.
 *
 * **0.35, not the WCAG crossover at ~0.18.** Maximising the contrast ratio would put black
 * text on purple, indigo and blue, because dark text technically scores higher on every
 * mid-tone. Nobody ships that: white on a saturated brand colour is the universal convention
 * and reads better than the arithmetic suggests at bubble sizes. The threshold is placed
 * where it actually matters — the light end of the palette, where white genuinely fails.
 *
 * Against the shipped presets it selects dark text for amber (0.44), green (0.42) and teal
 * (0.37), and white for everything darker. `styles.test.ts` pins that.
 */
export function contrastFor(hex: string): string {
  const rgb = parseHex(hex)
  if (rgb === undefined) return '#ffffff'
  return luminance(rgb) > 0.35 ? '#12111a' : '#ffffff'
}

/**
 * Writes one colour family onto the document root, as `--lc-<prefix>*`.
 *
 * Shared by the accent and the expert colour so the two can never drift into having
 * different token shapes — the stylesheet and `theme.ts` both assume every family has the
 * same members, and a missing one resolves to nothing and paints transparent.
 *
 * `setProperty` is CSSOM, so this needs no `style-src` either. The stylesheet reads only
 * these variables, which is what lets a colour change instantly with no re-render and no
 * second copy of the palette.
 */
function writeTokens(prefix: string, hex: string, fallback: string): void {
  const rgb = parseHex(hex) ?? parseHex(fallback)
  if (rgb === undefined) return
  const root = document.documentElement.style
  const base = toHex(rgb)

  root.setProperty(`--lc-${prefix}`, base)
  root.setProperty(`--lc-${prefix}-deep`, toHex(shade(rgb, 0.62)))
  root.setProperty(`--lc-${prefix}-bright`, toHex(shade(rgb, 1.22)))
  root.setProperty(`--lc-${prefix}-contrast`, contrastFor(base))
  // Alpha tints, for hovers and rings that must not fight the editor theme underneath.
  root.setProperty(`--lc-${prefix}-a12`, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`)
  root.setProperty(`--lc-${prefix}-a20`, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.20)`)
  root.setProperty(`--lc-${prefix}-a35`, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`)
}

/** The product's own colour: buttons, bubbles, selection, focus rings. */
export function applyAccent(hex: string): void {
  writeTokens('accent', hex, DEFAULT_ACCENT)
}

/**
 * The expert's colour (§12b) — what marks text that came from Claude rather than from the
 * primary model.
 *
 * Separate from the accent on purpose. The accent says "this is Light Code"; this says "these
 * words came from somewhere else", and a single colour cannot say both. It is configurable
 * because the default sits close to an amber or rose accent, and only the user can see
 * whether their particular pair reads as two colours or one.
 */
export function applyExpert(hex: string): void {
  writeTokens('expert', hex, DEFAULT_EXPERT)
}

/*
 * Timings are deliberately short. 120–180ms reads as responsive; past ~250ms an interface
 * feels like it is waiting for you, which is the opposite of the intent.
 */
const CSS = `
:root {
  --lc-ease: cubic-bezier(0.22, 0.85, 0.28, 1);
  --lc-fast: 130ms;
  --lc-med: 190ms;
}

/* ---- buttons: soft press, gentle hover, accent focus ring ----
 *
 * Targeted by element rather than by class, deliberately. Every button in the product then
 * gets this without fifty call sites having to remember a className, and a new one is
 * consistent by default instead of by discipline.
 *
 * **The hover tint is an inset box-shadow, not a background-color, and that is not a style
 * choice.** Inline styles beat stylesheet rules, and nearly every button here sets its own
 * "background" inline (the accent gradient, "transparent", the VS Code button colour). A
 * "background-color" rule would therefore be silently ignored on exactly the buttons that
 * matter. An inset shadow large enough to flood the box paints over any background, is set
 * inline nowhere, and leaves the icon on top.
 */

button,
[role='button'] {
  transition:
    box-shadow var(--lc-med) var(--lc-ease),
    transform 110ms var(--lc-ease),
    color var(--lc-fast) var(--lc-ease),
    border-color var(--lc-fast) var(--lc-ease),
    opacity var(--lc-fast) linear;
  -webkit-tap-highlight-color: transparent;
}

button:hover:not(:disabled):not([aria-disabled='true']),
[role='button']:hover:not([aria-disabled='true']) {
  box-shadow: inset 0 0 0 999px var(--lc-accent-a12);
}

/* The "soft click": a small inward press, quick going in and eased coming out. */
button:active:not(:disabled):not([aria-disabled='true']),
[role='button']:active:not([aria-disabled='true']) {
  transform: scale(0.93);
  transition-duration: 60ms;
}

button:focus-visible,
[role='button']:focus-visible,
a:focus-visible {
  outline: 2px solid var(--lc-accent);
  outline-offset: 2px;
}
/* Keyboard focus only. A ring after every mouse click is noise. */
button:focus:not(:focus-visible) { outline: none; }

/* The primary action glows instead of dimming — it should feel like the affirmative one. */
.lc-btn-accent:hover:not(:disabled) {
  box-shadow: inset 0 0 0 999px rgba(255, 255, 255, 0.14), 0 2px 12px var(--lc-accent-a35);
}
.lc-btn-accent:active:not(:disabled) { box-shadow: 0 1px 4px var(--lc-accent-a35); }

/* ---- inputs ---- */

input,
textarea,
select {
  transition: border-color var(--lc-fast) var(--lc-ease), box-shadow var(--lc-med) var(--lc-ease);
}
/* "!important" earned for the same reason as above: the border is set inline everywhere. */
input:focus,
textarea:focus,
select:focus {
  border-color: var(--lc-accent) !important;
  box-shadow: 0 0 0 3px var(--lc-accent-a20);
  outline: none;
}
.lc-input:focus-within {
  border-color: var(--lc-accent) !important;
  box-shadow: 0 0 0 3px var(--lc-accent-a20);
}
::selection { background: var(--lc-accent-a35); }

/* ---- native form controls ----
 *
 * Checkboxes, radios and range thumbs are drawn by the user agent, not from CSS boxes, so
 * none of the rules above reach them and neither do the --vscode-* variables. They were
 * rendering in Chromium's default blue against a purple UI.
 *
 * "accent-color" is the one property the UA honours for that internal painting. Set on the
 * root so it cascades to every control in the product, including ones not written yet.
 */
:root {
  accent-color: var(--lc-accent);
}

input[type='checkbox'],
input[type='radio'] {
  /* The UA default is ~13px and cramped beside 13px label text. */
  width: 14px;
  height: 14px;
  cursor: pointer;
  flex-shrink: 0;
}
input[type='checkbox']:focus-visible,
input[type='radio']:focus-visible {
  outline: 2px solid var(--lc-accent);
  outline-offset: 2px;
}

/*
 * The dropdown popup's highlight.
 *
 * "optionStyle()" already sets each option's background inline, which fixes the white list
 * on Windows and Linux — but the *selected* row is painted with the system highlight colour
 * (blue) on top of that, and Chromium ignores "background-color" on "option:checked". A
 * flooding inset box-shadow is the one declaration it does honour, so that is what tints it.
 *
 * macOS draws the popup with the system appearance and ignores all of this; nothing can be
 * done there, and it already follows the OS dark mode.
 */
option:checked,
option[selected] {
  box-shadow: 0 0 10px 100px var(--lc-accent) inset;
  color: var(--lc-accent-contrast) !important;
}
option:hover {
  box-shadow: 0 0 10px 100px var(--lc-accent-a35) inset;
}

/* ---- message entry ---- */

/*
 * Bubbles arrive from the side they belong to, which is what makes the direction of the
 * conversation legible before you have read a word.
 */
@keyframes lc-in-left {
  from { opacity: 0; transform: translate3d(-10px, 8px, 0) scale(0.97); }
  to   { opacity: 1; transform: none; }
}
@keyframes lc-in-right {
  from { opacity: 0; transform: translate3d(10px, 8px, 0) scale(0.97); }
  to   { opacity: 1; transform: none; }
}
@keyframes lc-fade-up {
  from { opacity: 0; transform: translate3d(0, 6px, 0); }
  to   { opacity: 1; transform: none; }
}

.lc-in-left  { animation: lc-in-left  260ms var(--lc-ease) both; }
.lc-in-right { animation: lc-in-right 260ms var(--lc-ease) both; }
.lc-fade-up  { animation: lc-fade-up  200ms var(--lc-ease) both; }

.lc-bubble {
  transition: box-shadow var(--lc-med) var(--lc-ease);
}

/* ---- the working indicator ---- */

@keyframes lc-spin { to { transform: rotate(360deg); } }
.lc-spin { animation: lc-spin 900ms linear infinite; transform-origin: 50% 50%; }

@keyframes lc-typing {
  0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
  30%           { opacity: 1;    transform: translateY(-3px); }
}
.lc-dot { animation: lc-typing 1.25s ease-in-out infinite; }
.lc-dot:nth-child(2) { animation-delay: 0.16s; }
.lc-dot:nth-child(3) { animation-delay: 0.32s; }

/* A quiet accent shimmer while the model streams, so "working" is visible peripherally. */
@keyframes lc-sheen { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.lc-sheen {
  background-image: linear-gradient(90deg, transparent, var(--lc-accent-a35), transparent);
  background-size: 200% 100%;
  animation: lc-sheen 1.6s linear infinite;
}

/* ---- panels and tabs ---- */

.lc-panel { animation: lc-fade-up 180ms var(--lc-ease) both; }

.lc-tab {
  position: relative;
  transition: color var(--lc-fast) var(--lc-ease), background-color var(--lc-fast) var(--lc-ease);
}
/* Scales from the centre so switching tabs slides rather than blinks. */
.lc-tab::after {
  content: '';
  position: absolute;
  left: 6px; right: 6px; bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--lc-accent);
  transform: scaleX(0);
  transition: transform var(--lc-med) var(--lc-ease);
}
.lc-tab[aria-selected='true']::after { transform: scaleX(1); }
.lc-tab:hover { background-color: var(--lc-accent-a12); }

/* ---- swatches ---- */

.lc-swatch {
  transition: transform var(--lc-fast) var(--lc-ease), box-shadow var(--lc-fast) var(--lc-ease);
}
.lc-swatch:hover { transform: scale(1.12); }
.lc-swatch:active { transform: scale(0.95); }
.lc-swatch[aria-pressed='true'] { box-shadow: 0 0 0 2px var(--vscode-editor-background), 0 0 0 4px var(--lc-accent); }

/* ---- scrollbars, tinted to match ---- */

.lc-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.lc-scroll::-webkit-scrollbar-track { background: transparent; }
.lc-scroll::-webkit-scrollbar-thumb {
  background: var(--lc-accent-a20);
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: content-box;
}
.lc-scroll::-webkit-scrollbar-thumb:hover { background: var(--lc-accent-a35); background-clip: content-box; }

/* ---- accessibility ----
 * Respected rather than assumed away: vestibular disorders make sliding bubbles genuinely
 * unpleasant, and this whole file is decoration. Everything still arrives, instantly.
 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .lc-btn:active:not(:disabled) { transform: none; }
}
`

/** Exported for `styles.test.ts`, which validates it — see `installStyles` for why. */
export const STYLESHEET = CSS

let installed = false

/**
 * Adopts the stylesheet. Idempotent, so a hot reload or a second mount cannot stack copies.
 *
 * **Two failure modes, and they must not be conflated.** An environment without
 * constructable stylesheets should lose the animations and keep the panel — everything
 * structural is inline-styled, so that degradation is fine and silent.
 *
 * A `replaceSync` that throws on a *supported* engine is different: it means the CSS below
 * has a syntax error, the whole sheet is dropped, and the UI silently loses every hover,
 * transition and animation at once. Swallowing that would make a one-character typo
 * undiagnosable, so it is reported. `styles.test.ts` additionally checks the sheet's brace
 * balance and that every custom property it reads is one something actually defines, since
 * an undefined `var()` resolves to nothing and paints as transparent rather than erroring.
 */
export function installStyles(): void {
  if (installed) return
  installed = true

  if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in Document.prototype)) {
    // Deliberately not falling back to a <style> element — that is exactly the `style-src`
    // allowance this module exists to avoid.
    return
  }

  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(CSS)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  } catch (error) {
    console.error('Light Code: the stylesheet failed to parse, so the UI will have no transitions.', error)
  }
}
