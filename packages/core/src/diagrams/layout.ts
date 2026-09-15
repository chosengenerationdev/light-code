import type { DiagramSpec, NodeIcon, NodeShape, NodeTone } from './types.js'

/**
 * Where every box and arrow goes.
 *
 * A layered layout — the family Sugiyama described and every flow-chart tool uses. Three passes,
 * each solving one thing:
 *
 * 1. **Rank.** How far along the flow each node sits, from the longest path to it.
 * 2. **Order.** Which order they sit in across a rank, chosen to reduce crossings.
 * 3. **Place.** Actual coordinates, from measured box sizes.
 *
 * ## Why it is written here rather than pulled in
 *
 * Every layout library brings a renderer, a DOM dependency or both — dagre and elk are hundreds
 * of kilobytes each, in a product whose whole diagram feature is a few hundred lines. The same
 * reasoning that wrote the PDF parser and the LCS differ by hand.
 *
 * ## Cycles
 *
 * Real flows loop — retry, "back to review". A cycle has no longest path, so edges that point
 * *backwards* are found first and excluded from ranking. They are still drawn; they simply do not
 * get a say in what comes before what. Ignoring that is how a layout engine hangs.
 */

/** Everything the renderer needs, with no knowledge of how it was decided. */
export interface DiagramLayout {
  width: number
  height: number
  title: string | undefined
  note: string | undefined
  nodes: PlacedNode[]
  edges: RoutedEdge[]
}

export interface PlacedNode {
  id: string
  label: string
  note: string | undefined
  shape: NodeShape
  tone: NodeTone
  icon: NodeIcon | undefined
  x: number
  y: number
  width: number
  height: number
}

export interface RoutedEdge {
  from: string
  to: string
  label: string | undefined
  dashed: boolean
  /** The line, as points. Two for a straight run, four for a step around a rank. */
  points: { x: number; y: number }[]
  /** Where the label sits, when there is one. */
  labelAt: { x: number; y: number }
}

const NODE_HEIGHT = 52
const NOTE_EXTRA = 14
const MIN_WIDTH = 96
const MAX_WIDTH = 260
/** Rough advance per character. No font metrics exist here, and being a little generous is safe. */
const CHAR_WIDTH = 7.4
const PADDING_X = 28
const GAP_WITHIN_RANK = 28
const GAP_BETWEEN_RANKS = 64
const MARGIN = 28
const TITLE_HEIGHT = 40

/** Width a box needs for its text, clamped so one long label cannot stretch the whole diagram. */
function widthFor(label: string, note: string | undefined): number {
  const longest = Math.max(label.length, note?.length ?? 0)
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(longest * CHAR_WIDTH) + PADDING_X * 2))
}

/**
 * Edges that point back the way we came.
 *
 * Found by depth-first search from every node: an edge reaching a node still on the stack closes a
 * cycle. Those are excluded from ranking only — they are drawn like any other.
 */
function backEdges(spec: DiagramSpec): Set<number> {
  const outgoing = new Map<string, { to: string; index: number }[]>()
  for (const [index, edge] of spec.edges.entries()) {
    const list = outgoing.get(edge.from) ?? []
    list.push({ to: edge.to, index })
    outgoing.set(edge.from, list)
  }

  const back = new Set<number>()
  const state = new Map<string, 'open' | 'done'>()

  const visit = (id: string): void => {
    state.set(id, 'open')
    for (const edge of outgoing.get(id) ?? []) {
      const seen = state.get(edge.to)
      if (seen === 'open') back.add(edge.index)
      else if (seen === undefined) visit(edge.to)
    }
    state.set(id, 'done')
  }

  // Every node, not only the roots: a cycle with nothing pointing into it has no root at all.
  for (const node of spec.nodes) if (!state.has(node.id)) visit(node.id)
  return back
}

/** How far along the flow each node sits: one past the furthest thing that reaches it. */
function rank(spec: DiagramSpec, back: Set<number>): Map<string, number> {
  const incoming = new Map<string, string[]>()
  for (const node of spec.nodes) incoming.set(node.id, [])
  for (const [index, edge] of spec.edges.entries()) {
    if (back.has(index)) continue
    incoming.get(edge.to)?.push(edge.from)
  }

  const ranks = new Map<string, number>()
  const resolving = new Set<string>()
  const rankOf = (id: string): number => {
    const known = ranks.get(id)
    if (known !== undefined) return known
    // A guard rather than a possibility: back edges are already gone, so this cannot fire — and
    // if a future change breaks that, a wrong rank beats a stack overflow.
    if (resolving.has(id)) return 0
    resolving.add(id)
    const parents = incoming.get(id) ?? []
    const depth = parents.length === 0 ? 0 : Math.max(...parents.map((parent) => rankOf(parent) + 1))
    resolving.delete(id)
    ranks.set(id, depth)
    return depth
  }

  for (const node of spec.nodes) rankOf(node.id)
  return ranks
}

/**
 * Orders each rank to reduce crossings.
 *
 * One barycentre pass: a node sits near the average position of the things pointing at it. Not
 * optimal — crossing minimisation is NP-hard — and one pass removes most of what a reader notices.
 * Ties keep declaration order, so the same spec always draws the same picture.
 */
function order(spec: DiagramSpec, ranks: Map<string, number>, back: Set<number>): string[][] {
  const byRank: string[][] = []
  for (const node of spec.nodes) {
    const depth = ranks.get(node.id) ?? 0
    while (byRank.length <= depth) byRank.push([])
    byRank[depth]?.push(node.id)
  }

  const parents = new Map<string, string[]>()
  for (const [index, edge] of spec.edges.entries()) {
    if (back.has(index)) continue
    const list = parents.get(edge.to) ?? []
    list.push(edge.from)
    parents.set(edge.to, list)
  }

  for (let depth = 1; depth < byRank.length; depth += 1) {
    const above = byRank[depth - 1] ?? []
    const positions = new Map(above.map((id, index) => [id, index]))
    const row = byRank[depth] ?? []
    const keyed = row.map((id, index) => {
      const known = (parents.get(id) ?? [])
        .map((parent) => positions.get(parent))
        .filter((value): value is number => value !== undefined)
      // No parent on the rank above keeps its place rather than being pulled to the left edge.
      const barycentre = known.length === 0 ? index : known.reduce((a, b) => a + b, 0) / known.length
      return { id, barycentre, index }
    })
    keyed.sort((a, b) => a.barycentre - b.barycentre || a.index - b.index)
    byRank[depth] = keyed.map((entry) => entry.id)
  }

  return byRank
}

/** Lays the spec out. Pure and deterministic: the same spec always gives the same coordinates. */
export function layoutDiagram(spec: DiagramSpec): DiagramLayout {
  const sideways = spec.direction === 'right'
  const back = backEdges(spec)
  const ranks = rank(spec, back)
  const rows = order(spec, ranks, back)
  const byId = new Map(spec.nodes.map((node) => [node.id, node]))

  const sizes = new Map<string, { width: number; height: number }>()
  for (const node of spec.nodes) {
    sizes.set(node.id, {
      width: widthFor(node.label, node.note),
      height: NODE_HEIGHT + (node.note === undefined ? 0 : NOTE_EXTRA),
    })
  }

  /*
   * Laid out top-to-bottom always, then transposed for `right`.
   *
   * One set of arithmetic rather than two that must agree. The cost is that a sideways diagram
   * sizes its boxes by the same rule, which is right anyway — a box is as wide as its text
   * whichever way the arrows point.
   */
  const rankExtent = rows.map((row) =>
    Math.max(...row.map((id) => sizes.get(id)?.height ?? NODE_HEIGHT)),
  )
  const rowWidths = rows.map(
    (row) =>
      row.reduce((total, id) => total + (sizes.get(id)?.width ?? MIN_WIDTH), 0) +
      GAP_WITHIN_RANK * Math.max(0, row.length - 1),
  )
  const widest = Math.max(...rowWidths, 1)

  const placed: PlacedNode[] = []
  let cursor = MARGIN + (spec.title === undefined ? 0 : TITLE_HEIGHT)
  for (const [depth, row] of rows.entries()) {
    const extent = rankExtent[depth] ?? NODE_HEIGHT
    let x = MARGIN + (widest - (rowWidths[depth] ?? 0)) / 2
    for (const id of row) {
      const node = byId.get(id)
      const size = sizes.get(id)
      if (node === undefined || size === undefined) continue
      placed.push({
        id,
        label: node.label,
        note: node.note,
        shape: node.shape ?? 'box',
        // A start or an end is accented unless the model said otherwise: the entry and exit of a
        // flow are what a reader looks for first.
        tone: node.tone ?? (node.shape === 'round' ? 'accent' : 'neutral'),
        icon: node.icon,
        x,
        // Centred in its rank, so a tall box beside a short one does not look misaligned.
        y: cursor + (extent - size.height) / 2,
        width: size.width,
        height: size.height,
      })
      x += size.width + GAP_WITHIN_RANK
    }
    cursor += extent + GAP_BETWEEN_RANKS
  }

  const upright = {
    width: widest + MARGIN * 2,
    height: cursor - GAP_BETWEEN_RANKS + MARGIN,
  }

  const nodes = sideways
    ? placed.map((node) => ({
        ...node,
        x: node.y,
        y: node.x,
        // Size is not transposed: a box swapping its width for its height would wrap its text.
      }))
    : placed
  const size = sideways
    ? { width: upright.height, height: upright.width }
    : { width: upright.width, height: upright.height }

  const positions = new Map(nodes.map((node) => [node.id, node]))
  const edges: RoutedEdge[] = spec.edges.flatMap((edge, index) => {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (from === undefined || to === undefined) return []

    const start = sideways
      ? { x: from.x + from.width, y: from.y + from.height / 2 }
      : { x: from.x + from.width / 2, y: from.y + from.height }
    const end = sideways
      ? { x: to.x, y: to.y + to.height / 2 }
      : { x: to.x + to.width / 2, y: to.y }

    /*
     * A back edge is routed around the outside rather than straight through everything between
     * its ends, which is where it would otherwise pass. Drawn from the side of each box for the
     * same reason: a line leaving the bottom and arriving at the bottom reads as a loop.
     */
    const isBack = back.has(index)
    const points = isBack
      ? sideways
        ? [
            { x: from.x + from.width / 2, y: from.y + from.height },
            { x: from.x + from.width / 2, y: size.height - MARGIN / 2 },
            { x: to.x + to.width / 2, y: size.height - MARGIN / 2 },
            { x: to.x + to.width / 2, y: to.y + to.height },
          ]
        : [
            { x: from.x + from.width, y: from.y + from.height / 2 },
            { x: size.width - MARGIN / 2, y: from.y + from.height / 2 },
            { x: size.width - MARGIN / 2, y: to.y + to.height / 2 },
            { x: to.x + to.width, y: to.y + to.height / 2 },
          ]
      : [start, end]

    const midpoint = points.length === 2 ? 0 : 1
    const a = points[midpoint] ?? start
    const b = points[midpoint + 1] ?? end

    return [
      {
        from: edge.from,
        to: edge.to,
        label: edge.label,
        dashed: edge.style === 'dashed',
        points,
        labelAt: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      },
    ]
  })

  return {
    width: size.width,
    height: size.height,
    title: spec.title,
    note: spec.note,
    nodes,
    edges,
  }
}
