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
