import type { DiagramLayout, PlacedNode } from './layout.js'
import type { NodeIcon, NodeTone } from './types.js'

/**
 * A layout, as an SVG document.
 *
 * ## Escaping is the whole security story
 *
 * Every string in here that came from the model is a *label*, and every one goes through `escape`
 * before it reaches the output. Nothing model-authored becomes markup, so the document cannot
 * carry an element, an attribute or a script — it carries text, inside elements this file chose.
 *
 * That is what makes the result safe to hand to a renderer, and it is the same rule `apply_diff`
 * follows with its preview: what is shown is computed here, never relayed.
 *
 * It is still rendered through an `<img>` rather than inlined, which is belt and braces: an SVG
 * loaded that way cannot run script whatever it contains, which is how the guide diagrams are
 * already served.
 *
 * ## Why the palette is an argument
 *
 * Because the colours belong to the editor and this module does not know what theme is active.
 * The layout is decided at tool time and the drawing at render time, so the same diagram follows
 * the user from light to dark without being computed again.
 */

export interface DiagramPalette {
  background: string
  /** Box outlines and arrows. */
  line: string
  /** Box fill. */
  surface: string
  text: string
  /** Notes, edge labels — anything secondary. */
  muted: string
  /** The user's own accent, so a diagram belongs to the same product as the rest of the panel. */
  accent: string
  /** Whether the background is dark, which decides how a tone is tinted. */
  dark?: boolean
}

export const DEFAULT_PALETTE: DiagramPalette = {
  background: '#ffffff',
  line: '#5b6b7a',
  surface: '#f6f8fa',
  text: '#141b22',
  muted: '#5b6b7a',
  accent: '#22c55e',
}

/**
 * A tone's own colour, before it is softened into a fill.
 *
 * Fixed hues rather than theme variables, because the *meaning* is the point: danger has to look
 * like danger on anybody's editor, and a red taken from a theme that has no red would not. The
 * accent is the exception — that one is genuinely the user's.
 */
const TONE_HUES: Record<Exclude<NodeTone, 'neutral' | 'muted' | 'accent'>, string> = {
  info: '#3b82f6',
  success: '#22a55e',
  warning: '#d97706',
  danger: '#dc2626',
}

/** Fill, outline and text for a tone, against the current background. */
function tonePaint(
  tone: NodeTone,
  palette: DiagramPalette,
): { fill: string; fillOpacity: number; stroke: string; text: string; icon: string } {
  if (tone === 'neutral') {
    return {
      fill: palette.surface,
      fillOpacity: 1,
      stroke: palette.line,
      text: palette.text,
      icon: palette.muted,
    }
  }
  if (tone === 'muted') {
    return {
      fill: palette.background,
      fillOpacity: 1,
      stroke: palette.muted,
      text: palette.muted,
      icon: palette.muted,
    }
  }
  const hue = tone === 'accent' ? palette.accent : TONE_HUES[tone]
  /*
   * A tint of the hue, not the hue itself.
   *
   * A box filled with saturated red and captioned in black is unreadable, and six of them beside
   * each other is a warning label rather than a diagram. The outline and the text carry the colour
   * at full strength; the fill carries it at a tenth, which is enough to group at a glance.
   *
   * Opacity does the tinting rather than arithmetic on the hex, because the correct blend depends
   * on the background and the background is the thing that changes with the theme.
   *
   * As an *attribute* rather than eight-digit hex, so it works whatever notation the colour
   * arrived in. The accent comes from the panel and reaches here as `rgb(…)`, and `rgb(…)1f` is
   * not a colour at all — it is an invalid attribute value, which SVG resolves by painting the
   * default. That is a whole box drawn in black on a dark theme.
   */
  return {
    fill: hue,
    fillOpacity: palette.dark === true ? 0.2 : 0.12,
    stroke: hue,
    text: palette.text,
    icon: hue,
  }
}

/**
 * The icons, as paths on a 16×16 grid.
 *
 * Drawn here rather than taken from a font or an emoji: a font is a dependency and a network
 * fetch, and an emoji renders differently on every platform and reads as a toy in a technical
 * drawing. Stroked rather than filled, so one set works on any fill and at any size.
 */
const ICON_PATHS: Record<NodeIcon, string> = {
  service: 'M2 4h12v3H2z M2 9h12v3H2z M4.5 5.5h.01 M4.5 10.5h.01',
  database: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2v8c0 1.1-2.2 2-5 2s-5-.9-5-2z M3 4c0 1.1 2.2 2 5 2s5-.9 5-2',
  user: 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M3 14c0-2.5 2.2-4 5-4s5 1.5 5 4',
  file: 'M4 2h5l3 3v9H4z M9 2v3h3',
  cloud: 'M5 12a3 3 0 0 1 .4-6 4 4 0 0 1 7.5 1.4A2.6 2.6 0 0 1 12 12z',
  lock: 'M4 7h8v7H4z M6 7V5a2 2 0 0 1 4 0v2',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M8 5v3.5l2 1.2',
  queue: 'M2 4h3v8H2z M6.5 4h3v8h-3z M11 4h3v8h-3z',
  code: 'M6 4 2.5 8 6 12 M10 4l3.5 4L10 12',
  mail: 'M2 4h12v8H2z M2 4.5 8 9l6-4.5',
  check: 'M3 8.5 6.5 12 13 4.5',
  cross: 'M4 4l8 8 M12 4l-8 8',
  warning: 'M8 2.5 14.5 13.5h-13z M8 6.5v3.2 M8 11.6h.01',
  gear: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z M8 1.6v2 M8 12.4v2 M1.6 8h2 M12.4 8h2 M3.5 3.5l1.4 1.4 M11.1 11.1l1.4 1.4 M12.5 3.5l-1.4 1.4 M4.9 11.1l-1.4 1.4',
}

/** The glyph, scaled and placed in the top-left of a box. */
function iconFor(node: PlacedNode, colour: string): string {
  if (node.icon === undefined) return ''
  const size = 15
  const scale = size / 16
  const x = node.x + 10
  const y = node.y + 9
  return `<g transform="translate(${String(x)},${String(y)}) scale(${String(scale)})" fill="none" stroke="${colour}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[node.icon]}" /></g>`
}

/**
 * XML-escapes a label.
 *
 * Both quote forms as well as the three structural characters: a label reaching an attribute
 * would otherwise be able to close it. Nothing here is conditional on where the text is going,
 * because a helper that is safe in one position and not another is one somebody eventually uses
 * in the wrong one.
 */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The outline of a box, as a path or shape element. */
function shapeFor(node: PlacedNode, palette: DiagramPalette): string {
  const { x, y, width: w, height: h } = node
  const paint = tonePaint(node.tone, palette)
  const common = `fill="${paint.fill}" fill-opacity="${String(paint.fillOpacity)}" stroke="${paint.stroke}" stroke-width="1.5"`

  if (node.shape === 'diamond') {
    const points = [
      `${String(x + w / 2)},${String(y)}`,
      `${String(x + w)},${String(y + h / 2)}`,
      `${String(x + w / 2)},${String(y + h)}`,
      `${String(x)},${String(y + h / 2)}`,
    ].join(' ')
    return `<polygon points="${points}" ${common} />`
  }

  if (node.shape === 'cylinder') {
    const lip = 7
    // A rectangle with an elliptical cap, which is how a store has been drawn since flowcharts
    // were drawn on paper — no key needed.
    return [
      `<path d="M${String(x)},${String(y + lip)} a${String(w / 2)},${String(lip)} 0 0 1 ${String(w)},0 v${String(h - lip * 2)} a${String(w / 2)},${String(lip)} 0 0 1 ${String(-w)},0 z" ${common} />`,
      `<path d="M${String(x)},${String(y + lip)} a${String(w / 2)},${String(lip)} 0 0 0 ${String(w)},0" fill="none" stroke="${paint.stroke}" stroke-width="1.5" />`,
    ].join('')
  }

  const radius = node.shape === 'round' ? h / 2 : 6
  return `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" rx="${String(radius)}" ${common} />`
}

/** Text centred in a box, with the note beneath it when there is one. */
function labelFor(node: PlacedNode, palette: DiagramPalette): string {
  const paint = tonePaint(node.tone, palette)
  const centreX = node.x + node.width / 2
  const baseline = node.note === undefined ? node.y + node.height / 2 + 5 : node.y + node.height / 2

  /*
   * Text keeps the theme's own foreground on every tone, because the fill is a tint rather than
   * the hue. That is the point of tinting: the colour groups the boxes and the words stay as
   * readable as the rest of the panel, instead of being white-on-green and failing the moment
   * somebody picks a pale accent.
   */
  const lines = [
    `<text x="${String(centreX)}" y="${String(baseline)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="${paint.text}">${escape(node.label)}</text>`,
  ]
  if (node.note !== undefined) {
    lines.push(
      `<text x="${String(centreX)}" y="${String(baseline + 16)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="${palette.muted}">${escape(node.note)}</text>`,
    )
  }
  return lines.join('')
}

/** Serialises a laid-out diagram. The only model-supplied content is escaped text. */
export function diagramSvg(layout: DiagramLayout, palette: DiagramPalette = DEFAULT_PALETTE): string {
  const parts: string[] = []

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(layout.width)}" height="${String(layout.height)}" viewBox="0 0 ${String(layout.width)} ${String(layout.height)}" role="img">`,
  )
  parts.push(
    `<defs><marker id="lc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${palette.line}" /></marker></defs>`,
  )
  parts.push(
    `<rect width="${String(layout.width)}" height="${String(layout.height)}" fill="${palette.background}" />`,
  )

  if (layout.title !== undefined) {
    parts.push(
      `<text x="${String(layout.width / 2)}" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" font-weight="600" fill="${palette.text}">${escape(layout.title)}</text>`,
    )
  }

  // Edges first, so a line can never be drawn over the box it arrives at.
  for (const edge of layout.edges) {
    const d = edge.points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)},${String(point.y)}`)
      .join(' ')
    parts.push(
      `<path d="${d}" fill="none" stroke="${palette.line}" stroke-width="1.5"${edge.dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#lc-arrow)" />`,
    )
    if (edge.label !== undefined) {
      const width = edge.label.length * 6.4 + 10
      parts.push(
        `<rect x="${String(edge.labelAt.x - width / 2)}" y="${String(edge.labelAt.y - 9)}" width="${String(width)}" height="17" rx="3" fill="${palette.background}" />`,
        `<text x="${String(edge.labelAt.x)}" y="${String(edge.labelAt.y + 4)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="${palette.muted}">${escape(edge.label)}</text>`,
      )
    }
  }

  for (const node of layout.nodes) {
    parts.push(
      shapeFor(node, palette),
      iconFor(node, tonePaint(node.tone, palette).icon),
      labelFor(node, palette),
    )
  }

  /*
   * The key, drawn with the same paint the boxes use.
   *
   * A swatch that does not match what it explains is worse than no key at all, so it goes through
   * `tonePaint` and `shapeFor` rather than being drawn a second way that has to be kept in step.
   */
  for (const entry of layout.legend) {
    const swatch: PlacedNode = {
      id: '',
      label: '',
      note: undefined,
      shape: entry.shape,
      tone: entry.tone,
      icon: undefined,
      x: entry.x,
      y: entry.y,
      width: entry.swatchWidth,
      height: entry.swatchHeight,
    }
    parts.push(shapeFor(swatch, palette))
    if (entry.icon !== undefined) {
      // Centred in the swatch rather than in its corner, which is where a node's icon sits: at
      // this size a corner is the edge.
      const paint = tonePaint(entry.tone, palette)
      const scale = 11 / 16
      parts.push(
        `<g transform="translate(${String(entry.x + entry.swatchWidth / 2 - 5.5)},${String(entry.y + entry.swatchHeight / 2 - 5.5)}) scale(${String(scale)})" fill="none" stroke="${paint.icon}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[entry.icon]}" /></g>`,
      )
    }
    parts.push(
      `<text x="${String(entry.x + entry.swatchWidth + 7)}" y="${String(entry.y + entry.swatchHeight - 4)}" font-family="system-ui, sans-serif" font-size="11" fill="${palette.muted}">${escape(entry.label)}</text>`,
    )
  }

  parts.push('</svg>')
  return parts.join('')
}

/**
 * The SVG as a `data:` URI, for an `<img>`.
 *
 * Percent-encoded rather than base64: it stays readable in devtools, avoids needing a base64
 * implementation that works in both a webview and Node, and is no larger for text this repetitive.
 */
export function diagramDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
