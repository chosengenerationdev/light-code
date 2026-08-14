import { describe, expect, it } from 'vitest'
import { ACCENT_PRESETS, contrastFor, DEFAULT_ACCENT, isValidAccent, parseHex } from './styles.js'

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
  it('leads with the brand purple', () => {
    expect(ACCENT_PRESETS[0]?.value).toBe(DEFAULT_ACCENT)
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
