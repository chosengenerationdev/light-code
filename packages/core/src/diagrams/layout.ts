import type { DiagramSpec, NodeIcon, NodeShape, NodeTone, TextSize } from './types.js'

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
  /** The key, laid out in rows under the drawing. Empty when the spec gave none. */
  legend: PlacedLegend[]
}

/** One key entry: a swatch drawn like a miniature node, and the text beside it. */
export interface PlacedLegend {
  label: string
  shape: NodeShape
  tone: NodeTone
  icon: NodeIcon | undefined
  x: number
  y: number
  swatchWidth: number
  swatchHeight: number
}

export interface PlacedNode {
  id: string
  /** The label, wrapped to fit the box. Never one string: SVG text does not wrap itself. */
  lines: string[]
  /** The note, wrapped the same way. Empty when there is none. */
  noteLines: string[]
  shape: NodeShape
  tone: NodeTone
  icon: NodeIcon | undefined
  /*
   * Everything the renderer needs to draw the text, decided here.
   *
   * The sizes travel with the node rather than being recomputed from a scale at drawing time,
   * because the *measurement* used them: a renderer that worked them out again could disagree by
   * a rounding, and disagreeing about a font size is how text stops fitting the box measured for
   * it. One owner, and the drawing does no arithmetic.
   */
  bold: boolean
  mono: boolean
  fontSize: number
  noteFontSize: number
  lineHeight: number
  noteLineHeight: number
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
const MIN_WIDTH = 96
/**
 * How wide a box may get before its label wraps instead.
 *
 * A threshold, not a clamp — and that distinction is the bug this replaced. It *was* a clamp:
 * anything longer than about twenty-seven characters got a box narrower than its own text, and
 * because SVG text does not wrap, the words simply ran out of the box and off the edge of the
 * canvas. Reported as words being chopped, which is exactly what it was.
 */
const MAX_WIDTH = 280
/**
 * Per-character advance for each face, at the base size. Generous on purpose.
 *
 * There are no font metrics here — the layout runs where no text can be measured — so every
 * estimate errs upwards. Too wide leaves a little air inside a box; too narrow puts the last word
 * through the wall.
 *
 * Every face needs its own number: bold is wider than regular at the same size, and a monospaced
 * face advances the same for an `i` as for a `W`.
 *
 * This is also why the family is a closed set rather than a string the model supplies. An
 * arbitrary face would be measured with the wrong number, and being wrong does not degrade
 * gracefully — it puts the last word through the wall, which is the bug this measurement exists
 * to prevent. A face nobody can measure is a face nobody should offer.
 */
const FACE_WIDTH = { regular: 7.6, bold: 8.2, mono: 8.0, monoBold: 8.0 } as const

/** Multipliers for the named sizes. Applied to the advance and the line height alike. */
const SIZE_SCALE: Record<TextSize, number> = {
  small: 0.85,
  normal: 1,
  large: 1.25,
  xlarge: 1.55,
}

/** The note's font is smaller, so more of it fits on a line. */
const NOTE_CHAR_WIDTH = 6.4
const LINE_HEIGHT = 17
const NOTE_LINE_HEIGHT = 14
/** The base sizes the scales multiply. Travel with each node so the renderer never recomputes. */
const LABEL_FONT_SIZE = 13
const NOTE_FONT_SIZE = 11
const PADDING_Y = 15
const PADDING_X = 28
const GAP_WITHIN_RANK = 28
const GAP_BETWEEN_RANKS = 64
const MARGIN = 28
const TITLE_HEIGHT = 40
const SWATCH_WIDTH = 26
const SWATCH_HEIGHT = 16
/** Between a swatch and its words. */
const SWATCH_GAP = 7
/** Between one entry and the next on a row. */
const LEGEND_ITEM_GAP = 22
const LEGEND_ROW_HEIGHT = 24
/** Between the drawing and the key, so the key reads as a separate thing. */
const LEGEND_TOP_GAP = 18

/**
 * Breaks text into lines that fit a given number of characters.
 *
 * On spaces where it can. A single word longer than the line is cut rather than allowed to
 * overflow — a hyphen would be a guess at where the word divides, and a word that long is nearly
 * always an identifier, where a break anywhere is equally arbitrary and equally readable.
 */
export function wrapText(text: string, perLine: number): string[] {
  const limit = Math.max(4, perLine)
  const lines: string[] = []
  let current = ''

  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    if (current.length === 0) {
      current = word
    } else if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
    while (current.length > limit) {
      lines.push(current.slice(0, limit))
      current = current.slice(limit)
    }
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/**
 * How big a box has to be to hold its text.
 *
 * Measured from the text rather than assumed: the width is what one line would need, up to the
 * wrap threshold, and the height then follows from how many lines that produced. Nothing here can
 * return a box its own content does not fit in, which is the property that was missing.
 */
interface Measured {
  width: number
  height: number
  lines: string[]
  noteLines: string[]
  fontSize: number
  noteFontSize: number
  lineHeight: number
  noteLineHeight: number
}

function boxFor(
  label: string,
  note: string | undefined,
  face: keyof typeof FACE_WIDTH = 'regular',
  size: TextSize = 'normal',
): Measured {
  const scale = SIZE_SCALE[size]
  const charWidth = FACE_WIDTH[face] * scale
  const noteCharWidth = NOTE_CHAR_WIDTH * scale
  const lineHeight = LINE_HEIGHT * scale
  const noteLineHeight = NOTE_LINE_HEIGHT * scale

  const ideal = Math.max(
    Math.round(label.length * charWidth),
    note === undefined ? 0 : Math.round(note.length * noteCharWidth),
  )
  /*
   * The wrap threshold grows with the text, so a larger size means a larger box rather than the
   * same box holding twice as many lines. Asking for bigger text and getting a tall thin column
   * is not what anybody means by bigger.
   */
  const maxWidth = MAX_WIDTH * scale
  const width = Math.min(maxWidth, Math.max(MIN_WIDTH, ideal + PADDING_X * 2))
  const usable = width - PADDING_X * 2

  const lines = wrapText(label, Math.floor(usable / charWidth))
  const noteLines = note === undefined ? [] : wrapText(note, Math.floor(usable / noteCharWidth))

  const textHeight = lines.length * lineHeight + noteLines.length * noteLineHeight
  return {
    width,
    height: Math.max(NODE_HEIGHT * scale, textHeight + PADDING_Y * 2),
    lines,
    noteLines,
    fontSize: LABEL_FONT_SIZE * scale,
    noteFontSize: NOTE_FONT_SIZE * scale,
    lineHeight,
    noteLineHeight,
  }
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

  const sizes = new Map<string, Measured>()
  for (const node of spec.nodes) {
    const bold = node.emphasis === 'bold'
    const mono = node.font === 'mono'
    const face = mono ? (bold ? 'monoBold' : 'mono') : bold ? 'bold' : 'regular'
    // The node's own size wins; the diagram's is the default for everything that did not say.
    sizes.set(node.id, boxFor(node.label, node.note, face, node.textSize ?? spec.textSize ?? 'normal'))
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
        lines: size.lines,
        noteLines: size.noteLines,
        bold: node.emphasis === 'bold',
        mono: node.font === 'mono',
        fontSize: size.fontSize,
        noteFontSize: size.noteFontSize,
        lineHeight: size.lineHeight,
        noteLineHeight: size.noteLineHeight,
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

  /*
   * The key goes underneath, in rows that wrap.
   *
   * Placed after the transposition rather than before it, in final coordinates: a key reads
   * left-to-right whichever way the arrows run, so turning it with the diagram would stand the
   * words on their side. It is the one part of this that is not a graph.
   */
  const legend: PlacedLegend[] = []
  let legendHeight = 0
  let canvasWidth = size.width
  if (spec.legend !== undefined && spec.legend.length > 0) {
    const entryWidths = spec.legend.map(
      (entry) => SWATCH_WIDTH + SWATCH_GAP + Math.round(entry.label.length * 6.6),
    )
    /*
     * Wrapped against the drawing's own width, and the canvas grows if one entry is wider than
     * that. Clipping the key would be worse than a wider picture — an explanation cut in half
     * explains nothing, and the reader cannot tell it was cut.
     */
    const available = Math.max(size.width - MARGIN * 2, Math.max(...entryWidths))
    let x = MARGIN
    let y = size.height + LEGEND_TOP_GAP
    let rows = 1
    for (const [index, entry] of spec.legend.entries()) {
      const entryWidth = entryWidths[index] ?? 0
      if (x > MARGIN && x + entryWidth - MARGIN > available) {
        x = MARGIN
        y += LEGEND_ROW_HEIGHT
        rows += 1
      }
      legend.push({
        label: entry.label,
        shape: entry.shape ?? 'box',
        tone: entry.tone ?? 'neutral',
        icon: entry.icon,
        x,
        y,
        swatchWidth: SWATCH_WIDTH,
        swatchHeight: SWATCH_HEIGHT,
      })
      x += entryWidth + LEGEND_ITEM_GAP
      canvasWidth = Math.max(canvasWidth, x - LEGEND_ITEM_GAP + MARGIN)
    }
    legendHeight = LEGEND_TOP_GAP + rows * LEGEND_ROW_HEIGHT
  }

  return {
    width: canvasWidth,
    height: size.height + legendHeight,
    title: spec.title,
    note: spec.note,
    nodes,
    edges,
    legend,
  }
}
