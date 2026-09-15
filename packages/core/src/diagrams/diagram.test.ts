import { describe, expect, it } from 'vitest'
import { layoutDiagram } from './layout.js'
import { diagramSvg } from './svg.js'
import { diagramSpecSchema, type DiagramSpec } from './types.js'

const spec = (over: Partial<DiagramSpec> = {}): DiagramSpec =>
  diagramSpecSchema.parse({
    nodes: [
      { id: 'a', label: 'Start', shape: 'round' },
      { id: 'b', label: 'Do the thing' },
      { id: 'c', label: 'Worked?', shape: 'diamond' },
      { id: 'd', label: 'Done', shape: 'round' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd', label: 'yes' },
      { from: 'c', to: 'b', label: 'no', style: 'dashed' },
    ],
    ...over,
  })

describe('what the spec refuses', () => {
  /*
   * De-duplicating would draw a diagram that is wrong in a way nobody can see: the edges meant
   * for one node would silently point at the other.
   */
  it('refuses two nodes with the same id', () => {
    const result = diagramSpecSchema.safeParse({
      nodes: [
        { id: 'a', label: 'One' },
        { id: 'a', label: 'Two' },
      ],
      edges: [],
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('Ids must be unique')
  })

  /* The known ids are listed, because the cause is nearly always a typo. */
  it('refuses an edge pointing at nothing, and says what does exist', () => {
    const result = diagramSpecSchema.safeParse({
      nodes: [{ id: 'a', label: 'One' }],
      edges: [{ from: 'a', to: 'b' }],
    })
    expect(result.success).toBe(false)
    // The issue itself, not a JSON rendering of it: stringify escapes the quotes around the id
    // and the assertion then tests the serialiser rather than the message.
    const message = result.error?.issues.map((issue) => issue.message).join(' ') ?? ''
    expect(message).toContain('No node has the id "b"')
    expect(message).toContain('Known ids: a')
  })
})

describe('laying it out', () => {
  it('ranks each node past everything that reaches it', () => {
    const layout = layoutDiagram(spec())
    const y = (id: string): number => layout.nodes.find((node) => node.id === id)?.y ?? -1
    expect(y('a')).toBeLessThan(y('b'))
    expect(y('b')).toBeLessThan(y('c'))
    expect(y('c')).toBeLessThan(y('d'))
  })

  /*
   * Real flows loop — retry, "back to review". A cycle has no longest path, so a layout that
   * ranked naively would recurse for ever. The edge is still drawn; it just gets no say in order.
   */
  it('does not hang on a cycle, and still draws the edge back', () => {
    const layout = layoutDiagram(spec())
    expect(layout.edges).toHaveLength(4)
    const loop = layout.edges.find((edge) => edge.from === 'c' && edge.to === 'b')
    expect(loop).toBeDefined()
    // Routed around the outside rather than straight back through everything in between.
    expect(loop?.points.length).toBe(4)
  })

  it('survives a graph that is nothing but a cycle', () => {
    const cyclic = diagramSpecSchema.parse({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    })
    const layout = layoutDiagram(cyclic)
    expect(layout.nodes).toHaveLength(2)
  })

  /* No box may sit on top of another, which is the one way a diagram is worse than no diagram. */
  it('never overlaps two boxes', () => {
    const layout = layoutDiagram(
      diagramSpecSchema.parse({
        nodes: Array.from({ length: 12 }, (_, index) => ({
          id: `n${String(index)}`,
          label: `Step number ${String(index)}`,
        })),
        edges: Array.from({ length: 11 }, (_, index) => ({
          from: `n${String(index)}`,
          to: `n${String(index + 1)}`,
        })),
      }),
    )
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a.id === b.id) continue
        const apart =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true)
      }
    }
  })

  it('keeps every box inside the canvas', () => {
    const layout = layoutDiagram(spec({ title: 'A flow' }))
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width)
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height)
    }
  })

  /* The same spec must always draw the same picture, or a redraw looks like a change. */
  it('is deterministic', () => {
    expect(JSON.stringify(layoutDiagram(spec()))).toBe(JSON.stringify(layoutDiagram(spec())))
  })

  it('runs left to right when asked', () => {
    const layout = layoutDiagram(spec({ direction: 'right' }))
    const x = (id: string): number => layout.nodes.find((node) => node.id === id)?.x ?? -1
    expect(x('a')).toBeLessThan(x('b'))
    expect(layout.width).toBeGreaterThan(layout.height)
  })
})

describe('the SVG', () => {
  /*
   * The whole security story. Every model-supplied string here is a label, and a label that
   * became markup would make a diagram a script-delivery mechanism.
   */
  it('escapes a label that tries to be markup', () => {
    const svg = diagramSvg(
      layoutDiagram(
        diagramSpecSchema.parse({
          nodes: [{ id: 'a', label: '<script>alert(1)</script>', note: 'a " quote' }],
          edges: [],
        }),
      ),
    )
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&quot;')
  })

  it('escapes a title, a note and an edge label too', () => {
    const svg = diagramSvg(
      layoutDiagram(
        diagramSpecSchema.parse({
          title: '<b>t</b>',
          note: '<b>n</b>',
          nodes: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          edges: [{ from: 'a', to: 'b', label: '<b>e</b>' }],
        }),
      ),
    )
    expect(svg).not.toContain('<b>')
    expect(svg.match(/&lt;b&gt;/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('draws one shape per node and one path per edge', () => {
    const svg = diagramSvg(layoutDiagram(spec()))
    expect(svg.match(/<polygon /g)).toHaveLength(1)
    expect(svg.match(/marker-end=/g)).toHaveLength(4)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
  })

  it('marks a dashed edge dashed', () => {
    const svg = diagramSvg(layoutDiagram(spec()))
    expect(svg).toContain('stroke-dasharray')
  })
})

/**
 * The key under the drawing.
 *
 * Written by the model rather than derived, because a tone means whatever this diagram is using it
 * to mean: `info` is an external system in one and a cached path in the next. Generating
 * "blue = info" would explain the palette rather than the picture.
 */
describe('the legend', () => {
  const withLegend = (entries: { label: string; tone?: string; shape?: string; icon?: string }[]) =>
    layoutDiagram(
      diagramSpecSchema.parse({
        nodes: [{ id: 'a', label: 'A' }],
        edges: [],
        legend: entries,
      }),
    )

  it('is absent when nothing asked for one', () => {
    expect(layoutDiagram(spec()).legend).toEqual([])
  })

  it('places one entry per line of the key', () => {
    const layout = withLegend([
      { label: 'succeeded', tone: 'success' },
      { label: 'needs a human', tone: 'warning', icon: 'user' },
    ])
    expect(layout.legend).toHaveLength(2)
    expect(layout.legend[0]?.label).toBe('succeeded')
    expect(layout.legend[1]?.icon).toBe('user')
  })

  /* Below the drawing, never over it: a key drawn on top of a box explains nothing. */
  it('sits under the diagram and makes room for itself', () => {
    const plain = layoutDiagram(
      diagramSpecSchema.parse({ nodes: [{ id: 'a', label: 'A' }], edges: [] }),
    )
    const keyed = withLegend([{ label: 'succeeded', tone: 'success' }])
    expect(keyed.height).toBeGreaterThan(plain.height)
    const lowest = Math.max(...keyed.nodes.map((node) => node.y + node.height))
    expect(keyed.legend[0]?.y).toBeGreaterThan(lowest)
  })

  /*
   * Clipping a key would be worse than a wider picture: an explanation cut in half explains
   * nothing, and the reader cannot tell it was cut.
   */
  it('widens the canvas rather than cutting a long entry off', () => {
    const layout = withLegend([
      { label: 'a very long explanation of what this particular colour is standing in for here' },
    ])
    const entry = layout.legend[0]
    expect(entry).toBeDefined()
    expect(layout.width).toBeGreaterThan((entry?.x ?? 0) + (entry?.swatchWidth ?? 0))
  })

  it('wraps onto another row rather than running off the side', () => {
    const layout = withLegend(
      Array.from({ length: 6 }, (_, index) => ({ label: `meaning number ${String(index)}` })),
    )
    const rows = new Set(layout.legend.map((entry) => entry.y))
    expect(rows.size).toBeGreaterThan(1)
    for (const entry of layout.legend) {
      expect(entry.x).toBeGreaterThanOrEqual(0)
      expect(entry.x).toBeLessThan(layout.width)
    }
  })

  it('draws a swatch and its words', () => {
    const svg = diagramSvg(withLegend([{ label: 'succeeded', tone: 'success', shape: 'round' }]))
    expect(svg).toContain('succeeded')
    // The swatch goes through the same painter the boxes use, so a key cannot drift from what it
    // explains — a rounded swatch is a `rect` with a radius, like the node it stands for.
    expect(svg.match(/<rect /g)?.length).toBeGreaterThan(2)
  })

  it('escapes a label in the key as well', () => {
    const svg = diagramSvg(withLegend([{ label: '<script>x</script>' }]))
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })
})

/**
 * Text has to fit inside the box drawn around it.
 *
 * Reported from real use: words chopped at the edge of the image. The box width was `Math.min(
 * MAX_WIDTH, …)` — a clamp, not a threshold — so a label over about twenty-seven characters got a
 * box narrower than its own text. SVG text does not wrap, so the words ran out of the box and off
 * the canvas.
 *
 * The fix is not a bigger canvas, which is what it looked like from outside: the box is sized from
 * the label and knows nothing about the canvas. Long labels wrap, and the box grows to hold the
 * lines.
 */
describe('a label longer than a box', () => {
  const longest = (id: string, layout: ReturnType<typeof layoutDiagram>): number => {
    const node = layout.nodes.find((entry) => entry.id === id)
    return Math.max(...(node?.lines ?? ['']).map((line) => line.length))
  }

  const withLabel = (label: string, note?: string) =>
    layoutDiagram(
      diagramSpecSchema.parse({
        nodes: [{ id: 'a', label, ...(note === undefined ? {} : { note }) }],
        edges: [],
      }),
    )

  it('wraps rather than overflowing', () => {
    const label = 'Validate the incoming payload against the published schema'
    const layout = withLabel(label)
    const node = layout.nodes[0]
    expect(node?.lines.length).toBeGreaterThan(1)
    // Every line has to fit the usable width of the box it is drawn in.
    const usable = (node?.width ?? 0) - 56
    for (const line of node?.lines ?? []) {
      expect(line.length * 7.6, `"${line}" is wider than its box`).toBeLessThanOrEqual(usable)
    }
  })

  it('grows the box to hold the lines it produced', () => {
    const short = withLabel('Step')
    const long = withLabel('Validate the incoming payload against the published schema')
    expect(long.nodes[0]?.height).toBeGreaterThan(short.nodes[0]?.height ?? 0)
  })

  it('loses none of the words', () => {
    const label = 'Validate the incoming payload against the published schema'
    expect(withLabel(label).nodes[0]?.lines.join(' ')).toBe(label)
  })

  it('wraps a long note too', () => {
    const layout = withLabel('Gateway', 'mutual TLS, with the client certificate from the machine store')
    expect(layout.nodes[0]?.noteLines.length).toBeGreaterThan(1)
  })

  /*
   * A single word longer than the line is cut rather than allowed to overflow. A hyphen would be a
   * guess at where the word divides, and a word this long is nearly always an identifier.
   */
  it('breaks a single unbroken word rather than letting it run out', () => {
    const layout = withLabel('supercalifragilisticexpialidociousandthensomemoreforgoodmeasure')
    expect(longest('a', layout) * 7.6).toBeLessThanOrEqual((layout.nodes[0]?.width ?? 0) - 56)
  })

  it('keeps a wrapped box inside the canvas', () => {
    const layout = layoutDiagram(
      diagramSpecSchema.parse({
        nodes: [
          { id: 'a', label: 'Validate the incoming payload against the published schema' },
          { id: 'b', label: 'Reject with a 422 and the first failing field named in the body' },
        ],
        edges: [{ from: 'a', to: 'b' }],
      }),
    )
    for (const node of layout.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width)
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height)
    }
  })
})
