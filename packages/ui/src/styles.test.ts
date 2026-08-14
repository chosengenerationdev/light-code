import { describe, expect, it } from 'vitest'
import {
  ACCENT_PRESETS,
  contrastFor,
  DEFAULT_ACCENT,
  DEFAULT_EXPERT,
  EXPERT_PRESETS,
  isValidAccent,
  parseHex,
  STYLESHEET,
} from './styles.js'

describe('accent parsing', () => {
  it('accepts both hex forms, with or without the hash', () => {
    expect(parseHex('#A855F7')).toEqual({ r: 168, g: 85, b: 247 })
    expect(parseHex('A855F7')).toEqual({ r: 168, g: 85, b: 247 })
    expect(parseHex('#f0a')).toEqual({ r: 255, g: 0, b: 170 })
  })

  it('rejects anything that is not a hex colour', () => {
    // The value reaches a CSS custom property, so "whatever the user typed" is not acceptable.
    for (const bad of ['', '#', 'purple', '#12345', '#1234567', 'rgb(1,2,3)', '#GGGGGG', 'javascript:x']) {
      expect(isValidAccent(bad), bad).toBe(false)
    }
  })

  it('tolerates surrounding whitespace, which a paste usually carries', () => {
    expect(isValidAccent('  #A855F7 ')).toBe(true)
  })
})

describe('contrast selection', () => {
  /**
   * The reason this is computed rather than hardcoded to white: the accent is user-chosen,
   * and white-on-amber is unreadable. A colour picker invites exactly that.
   */
  it('picks dark text on the light end of the palette', () => {
    expect(contrastFor('#F59E0B')).toBe('#12111a') // amber, luminance 0.44
    expect(contrastFor('#22C55E')).toBe('#12111a') // green, 0.42
    expect(contrastFor('#14B8A6')).toBe('#12111a') // teal, 0.37
  })

  /**
   * And white on saturated brand colours, which is the convention rather than the arithmetic
   * — the pure WCAG crossover would put black text on purple. See `contrastFor`.
   */
  it('keeps white on saturated mid-tones', () => {
    expect(contrastFor('#A855F7')).toBe('#ffffff') // purple, 0.22
    expect(contrastFor('#4338CA')).toBe('#ffffff') // indigo
    expect(contrastFor('#3B82F6')).toBe('#ffffff') // blue
    expect(contrastFor('#F43F5E')).toBe('#ffffff') // rose
  })

  it('handles the extremes', () => {
    expect(contrastFor('#ffffff')).toBe('#12111a')
    expect(contrastFor('#000000')).toBe('#ffffff')
  })

  it('falls back to white rather than throwing on a bad colour', () => {
    expect(contrastFor('not a colour')).toBe('#ffffff')
  })
})

describe('the preset palette', () => {
  it('leads with the default', () => {
    expect(ACCENT_PRESETS[0]?.value).toBe(DEFAULT_ACCENT)
  })

  /** The logo is still purple, so it has to stay reachable in one press. */
  it('still offers the logo purple', () => {
    expect(ACCENT_PRESETS.map((preset) => preset.value.toLowerCase())).toContain('#a855f7')
  })

  /**
   * Green is on the light side, so the default pairs with dark text. Pinned because getting
   * it wrong is invisible in a unit test and unreadable on screen.
   */
  it('pairs the default with dark text', () => {
    expect(DEFAULT_ACCENT).toBe('#22C55E')
    expect(contrastFor(DEFAULT_ACCENT)).toBe('#12111a')
  })

  it('offers only valid, distinct colours', () => {
    const values = ACCENT_PRESETS.map((preset) => preset.value)
    for (const value of values) expect(isValidAccent(value), value).toBe(true)
    expect(new Set(values.map((value) => value.toLowerCase())).size).toBe(values.length)
  })

  /** Every swatch has to be legible with the contrast the picker will pair it with. */
  it('produces a usable contrast for every preset', () => {
    for (const preset of ACCENT_PRESETS) {
      expect(['#ffffff', '#12111a']).toContain(contrastFor(preset.value))
    }
  })
})

/**
 * The stylesheet is 200 hand-written lines that nothing else validates.
 *
 * It is adopted through `replaceSync`, which throws on a syntax error and takes the *whole*
 * sheet with it — every hover, transition and animation in the product gone at once. And an
 * undefined `var()` does not throw at all: it resolves to nothing and paints as transparent,
 * which is worse, because it fails silently and only on the one element that used it.
 *
 * These checks are structural rather than a real CSS parse, but they catch the two mistakes
 * actually likely here: an unbalanced brace and a mistyped custom property.
 */
describe('the stylesheet', () => {
  it('has balanced braces', () => {
    const open = (STYLESHEET.match(/{/g) ?? []).length
    const close = (STYLESHEET.match(/}/g) ?? []).length
    expect(open).toBe(close)
  })

  it('defines every custom property it reads', () => {
    // Set by applyAccent() on the document root rather than declared in the sheet.
    const fromAccent = new Set([
      '--lc-accent',
      '--lc-accent-deep',
      '--lc-accent-bright',
      '--lc-accent-contrast',
      '--lc-accent-a12',
      '--lc-accent-a20',
      '--lc-accent-a35',
    ])
    const declared = new Set([...STYLESHEET.matchAll(/(--lc-[a-z0-9-]+)\s*:/g)].map((match) => match[1]))
    const read = [...STYLESHEET.matchAll(/var\((--lc-[a-z0-9-]+)/g)].map((match) => match[1])

    for (const name of read) {
      expect(fromAccent.has(name as string) || declared.has(name as string), `${String(name)} is read but never set`).toBe(true)
    }
  })

  /** Every one of these is a rule that would silently stop applying if the class were renamed. */
  it('carries the classes the components attach', () => {
    for (const className of ['lc-in-left', 'lc-in-right', 'lc-fade-up', 'lc-dot', 'lc-scroll', 'lc-tab', 'lc-swatch', 'lc-btn-accent', 'lc-panel']) {
      expect(STYLESHEET, className).toContain(`.${className}`)
    }
  })

  /** Vestibular disorders make sliding bubbles genuinely unpleasant; this is not optional. */
  it('honours prefers-reduced-motion', () => {
    expect(STYLESHEET).toContain('prefers-reduced-motion')
  })
})

/**
 * The expert colour marks text that came from Claude rather than the primary model (§12b).
 * Its whole job is to be distinguishable from the accent, so the properties worth pinning
 * are about the two of them together, not about either alone.
 */
describe('the expert palette', () => {
  it('defaults to something clearly different from the default accent', () => {
    expect(DEFAULT_EXPERT).toBe('#D97757')
    expect(DEFAULT_EXPERT.toLowerCase()).not.toBe(DEFAULT_ACCENT.toLowerCase())
  })

  it('leads with the default and offers only valid, distinct colours', () => {
    expect(EXPERT_PRESETS[0]?.value).toBe(DEFAULT_EXPERT)
    const values = EXPERT_PRESETS.map((preset) => preset.value)
    for (const value of values) expect(isValidAccent(value), value).toBe(true)
    expect(new Set(values.map((value) => value.toLowerCase())).size).toBe(values.length)
  })

  it('produces a usable contrast for every preset', () => {
    for (const preset of EXPERT_PRESETS) {
      expect(['#ffffff', '#12111a']).toContain(contrastFor(preset.value))
    }
  })

  /**
   * Both families must have the same token members, or a rule reading one that only the
   * other defines resolves to nothing and paints transparent. `writeTokens` is shared
   * precisely to make this true; this asserts nobody has since special-cased one of them.
   */
  it('gives the stylesheet the same token shape for both families', () => {
    const members = (prefix: string): string[] =>
      [...STYLESHEET.matchAll(new RegExp(String.raw`var\(--lc-${prefix}((?:-[a-z0-9]+)*)`, 'g'))]
        .map((match) => match[1] ?? '')
        .filter((suffix, index, all) => all.indexOf(suffix) === index)
        .sort()

    // Only meaningful for suffixes the sheet actually reads; the accent is read far more
    // widely, so this checks that every expert token read is one the accent family has too.
    for (const suffix of members('expert')) {
      expect(['', '-deep', '-bright', '-contrast', '-a12', '-a20', '-a35'], suffix).toContain(suffix)
    }
  })
})
