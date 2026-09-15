// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Diagram, fileNameFor, isDark, resolveColour } from './Diagram.js'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const spec = {
  title: 'Request path',
  nodes: [
    { id: 'a', label: 'Client', shape: 'round' as const, tone: 'accent' as const },
    { id: 'b', label: 'Service', icon: 'service' as const },
    { id: 'c', label: 'Failed', shape: 'round' as const, tone: 'danger' as const },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c', label: 'error', style: 'dashed' as const },
  ],
}

function renderedSvg(): string {
  act(() => root.render(<Diagram diagram={spec} />))
  const image = container.querySelector('img')
  const source = image?.getAttribute('src') ?? ''
  return decodeURIComponent(source.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))
}

/**
 * Every colour that reaches the SVG has to be a colour.
 *
 * Reported with a screenshot: labels invisible on a dark panel, no arrows at all, and box fills
 * that barely showed. One cause for all three — the palette was passed `var(--vscode-foreground)`
 * and friends straight from the theme, and **a CSS custom property does not reach an SVG loaded
 * through `<img>`**: that document has its own root and inherits nothing from the page.
 *
 * An invalid attribute value is not an error in SVG, it is a fallback: `fill` becomes black and
 * `stroke` becomes `none`. So the text went black on black and the arrows were never painted.
 * Nothing threw, nothing logged, and every test passed.
 */
describe('the colours that reach the diagram', () => {
  it('leaves no CSS variable in the rendered markup', () => {
    const svg = renderedSvg()
    expect(svg.length).toBeGreaterThan(0)
    // The specific failure: a `var(…)` anywhere in here is a colour that will not paint.
    expect(svg).not.toContain('var(')
    expect(svg).not.toContain('--vscode')
  })

  it('draws the arrows, which is what an unresolved stroke silently removed', () => {
    const svg = renderedSvg()
    expect(svg.match(/marker-end=/g)).toHaveLength(2)
    // A stroke that resolved to nothing is the bug; a stroke attribute naming a real colour is
    // the fix, so the value is checked rather than only its presence.
    const strokes = [...svg.matchAll(/stroke="([^"]+)"/g)].map((match) => match[1] ?? '')
    expect(strokes.length).toBeGreaterThan(0)
    for (const stroke of strokes) {
      expect(stroke).not.toContain('var(')
      expect(stroke).not.toBe('')
    }
  })

  /*
   * A tint is an opacity attribute, not eight-digit hex. The accent arrives as `rgb(…)` once it is
   * resolved, and `rgb(…)1f` is not a colour — it is an invalid value, which paints the default.
   */
  it('tints with an opacity attribute rather than by appending to the colour', () => {
    const svg = renderedSvg()
    expect(svg).toContain('fill-opacity=')
    expect(svg).not.toMatch(/fill="rgb\([^)]*\)[0-9a-f]{2}"/)
  })

  it('still renders the title, the label and the icon', () => {
    const svg = renderedSvg()
    expect(svg).toContain('Request path')
    expect(svg).toContain('Client')
    expect(svg).toContain('<g transform=')
  })
})

describe('resolving a colour', () => {
  it('turns a CSS value into something paintable', () => {
    // jsdom resolves a plain colour; the fallback covers the variable, which it does not define.
    expect(resolveColour('#ff0000', '#000000')).toContain('rgb')
    expect(resolveColour('var(--not-defined-anywhere)', '#123456')).toBe('#123456')
  })

  it('never returns the expression it was given', () => {
    expect(resolveColour('var(--vscode-foreground)', '#abcdef')).not.toContain('var(')
  })
})

describe('deciding whether a theme is dark', () => {
  /* It has to understand `rgb(…)`, because that is what a resolved colour actually is. */
  it('reads the notation a browser gives back', () => {
    expect(isDark('rgb(30, 30, 30)')).toBe(true)
    expect(isDark('rgb(255, 255, 255)')).toBe(false)
    expect(isDark('rgba(20, 20, 20, 1)')).toBe(true)
  })

  it('still reads hex', () => {
    expect(isDark('#1e1e1e')).toBe(true)
    expect(isDark('#ffffff')).toBe(false)
  })

  /*
   * Green is weighted far above blue: an average calls a saturated blue "light" when white text
   * on it is perfectly readable and black text is not.
   */
  it('weighs the channels perceptually', () => {
    expect(isDark('rgb(0, 0, 255)')).toBe(true)
    expect(isDark('rgb(0, 255, 0)')).toBe(false)
  })
})

/**
 * A filename built from a title the model wrote.
 *
 * Nothing a title contains may steer where a file lands: a label is model-authored text, and
 * `../` or a drive letter in one would otherwise reach the download name directly.
 */
describe('naming the saved file', () => {
  it('uses the title, flattened', () => {
    expect(fileNameFor('Request path through a cache')).toBe('request-path-through-a-cache')
  })

  it('keeps nothing that could be a path', () => {
    const name = fileNameFor('../../etc/passwd')
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
    expect(name).toBe('etc-passwd')
  })

  it('falls back rather than producing an empty name', () => {
    expect(fileNameFor(undefined)).toBe('diagram')
    expect(fileNameFor('!!!')).toBe('diagram')
  })

  /* A title can be a paragraph; a filename cannot. */
  it('does not run away with a very long title', () => {
    expect(fileNameFor('word '.repeat(80)).length).toBeLessThanOrEqual(60)
  })
})

describe('the buttons offered', () => {
  it('offers to copy and to save, in both formats', () => {
    act(() => root.render(<Diagram diagram={spec} />))
    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels).toContain('Copy SVG')
    expect(labels).toContain('Save SVG')
    expect(labels).toContain('Save PNG')
  })
})
