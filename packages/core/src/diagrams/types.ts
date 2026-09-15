import { z } from 'zod'

/**
 * A technical diagram, as the model describes it.
 *
 * ## Why a graph and not SVG
 *
 * The obvious design is to let the model write the SVG. It is the wrong one twice over.
 *
 * **Layout.** Models place boxes badly — overlapping shapes, edges crossing their own nodes,
 * coordinates that drift as the diagram grows. Describing *what connects to what* is the part a
 * model is good at; working out where things go is arithmetic, and arithmetic belongs here.
 *
 * **Safety.** Model-authored SVG is model-authored markup, and SVG carries script. Generating it
 * here from a validated graph means the only model-supplied strings in the output are text, and
 * text is escaped. The same reasoning as `apply_diff` computing its own preview: what is rendered
 * is derived, never relayed.
 *
 * ## Why the caps are what they are
 *
 * A diagram of sixty boxes is not a diagram, it is a wall. The limit is low enough to force the
 * useful version — and refused rather than truncated, because half a flow chart is worse than
 * none: it looks complete and is missing the step that mattered.
 */

export const DIAGRAM_MAX_NODES = 40
export const DIAGRAM_MAX_EDGES = 80

/**
 * The colours a node may take, by meaning rather than by value.
 *
 * Named tones, not hex. A model choosing `#3b82f6` is choosing a colour that may be invisible on
 * somebody's background, clash with the accent they picked, or mean nothing to the reader — and
 * three diagrams in one conversation would each pick differently. A tone is resolved at render
 * time against the active theme, so the same spec is legible in light and dark, and `danger`
 * always looks like danger.
 */
export const NODE_TONES = [
  'neutral',
  'accent',
  'info',
  'success',
  'warning',
  'danger',
  'muted',
] as const
export type NodeTone = (typeof NODE_TONES)[number]

/**
 * Icons a node may carry.
 *
 * A closed set, drawn as paths here rather than taken from a font or an emoji. A font is a
 * dependency and a network fetch; an emoji renders differently on every platform and reads as a
 * toy in a technical drawing. These are the shapes that recur in one: the things a system is made
 * of, and the states it ends up in.
 */
export const NODE_ICONS = [
  'service',
  'database',
  'user',
  'file',
  'cloud',
  'lock',
  'clock',
  'queue',
  'code',
  'mail',
  'check',
  'cross',
  'warning',
  'gear',
] as const
export type NodeIcon = (typeof NODE_ICONS)[number]

/** What a box means, by its outline. Conventional shapes, so no key is needed. */
export const NODE_SHAPES = ['box', 'round', 'diamond', 'cylinder'] as const
export type NodeShape = (typeof NODE_SHAPES)[number]

export const diagramNodeSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe('A short identifier, referenced by edges. Not shown.'),
  label: z.string().min(1).max(120).describe('The text in the box. Keep it to a few words.'),
  shape: z
    .enum(NODE_SHAPES)
    .optional()
    .describe(
      'box (a step, the default), round (a start or end), diamond (a decision), cylinder (a ' +
        'store or database).',
    ),
  /** Shown under the label, smaller. For the qualifier that would otherwise bloat the label. */
  note: z.string().max(120).optional().describe('A second, smaller line under the label.'),
  tone: z
    .enum(NODE_TONES)
    .optional()
    .describe(
      'What the box means, as a colour: success for a good outcome, danger for a failure, ' +
        'warning for a risk, info for an external system, accent for the thing being explained, ' +
        'muted for context. Resolved against the theme, so it stays legible in light and dark.',
    ),
  icon: z
    .enum(NODE_ICONS)
    .optional()
    .describe(
      'A small glyph in the corner of the box: service, database, user, file, cloud, lock, ' +
        'clock, queue, code, mail, check, cross, warning, gear.',
    ),
})

export const diagramEdgeSchema = z.object({
  from: z.string().min(1).describe('The id of the node the arrow leaves.'),
  to: z.string().min(1).describe('The id of the node the arrow enters.'),
  label: z
    .string()
    .max(60)
    .optional()
    .describe('Text on the arrow — the condition, or what flows along it. "yes", "on failure".'),
  style: z
    .enum(['solid', 'dashed'])
    .optional()
    .describe('dashed for something conditional, asynchronous or secondary.'),
})

export const diagramSpecSchema = z
  .object({
    title: z.string().max(120).optional(),
    direction: z
      .enum(['down', 'right'])
      .optional()
      .describe('Which way the flow runs. down is the default and suits most flows.'),
    nodes: z.array(diagramNodeSchema).min(1).max(DIAGRAM_MAX_NODES),
    edges: z.array(diagramEdgeSchema).max(DIAGRAM_MAX_EDGES),
    note: z
      .string()
      .max(400)
      .optional()
      .describe('A line under the diagram. Say what it leaves out, or where it came from.'),
  })
  .superRefine((spec, context) => {
    const ids = new Set<string>()
    for (const [index, node] of spec.nodes.entries()) {
      if (ids.has(node.id)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          /*
           * Named rather than de-duplicated. Two nodes sharing an id means the edges meant for one
           * of them are pointing at the other, and silently keeping the first would draw a diagram
           * that is wrong in a way nobody can see.
           */
          message: `Two nodes share the id "${node.id}". Ids must be unique — edges are resolved by them.`,
        })
      }
      ids.add(node.id)
    }
    for (const [index, edge] of spec.edges.entries()) {
      for (const [end, id] of [
        ['from', edge.from],
        ['to', edge.to],
      ] as const) {
        if (!ids.has(id)) {
          context.addIssue({
            code: 'custom',
            path: ['edges', index, end],
            // The available ids are listed: the usual cause is a typo, and a message that names
            // the candidates is one the model can act on without another round trip.
            message: `No node has the id "${id}". Known ids: ${[...ids].join(', ')}.`,
          })
        }
      }
    }
  })

export type DiagramSpec = z.infer<typeof diagramSpecSchema>
export type DiagramNode = z.infer<typeof diagramNodeSchema>
export type DiagramEdge = z.infer<typeof diagramEdgeSchema>
