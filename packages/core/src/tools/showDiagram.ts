import { layoutDiagram } from '../diagrams/layout.js'
import { diagramSpecSchema, type DiagramSpec } from '../diagrams/types.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Drawing a flow, an architecture or a sequence of steps.
 *
 * ## Why the model does not write the SVG
 *
 * Because the two halves of "draw a diagram" are good at different things. Describing what
 * connects to what is a modelling question and a model is good at it; deciding where the boxes go
 * is arithmetic, and a model laying out coordinates by hand produces overlapping shapes and edges
 * that cross their own nodes. So the model sends a graph and `diagrams/layout.ts` places it.
 *
 * It is also the safe half of the split: model-authored SVG is model-authored markup, and SVG
 * carries script. Generated here, the only model-supplied strings in the output are labels, and
 * labels are escaped.
 *
 * ## Why it is a control tool
 *
 * It presents; it does not act. Nothing is written, nothing runs, so there is nothing for the
 * approval gate to protect — the same reasoning as `show_chart`, whose shape this follows
 * deliberately rather than inventing a second way to put a picture in the conversation.
 */
export function createShowDiagramTool(): Tool<DiagramSpec> {
  return {
    name: 'show_diagram',
    group: 'always',
    // Short on purpose: advertised in every request, and the field descriptions carry the details
    // (tones, icons, text size, legend, direction). It was ~1,600 tokens with the schema.
    description:
      'Draw a technical diagram: a flow, an architecture, a sequence of steps, a state machine. Give ' +
      '`nodes` (`id`, `label`) and `edges` between ids; layout is automatic, never give coordinates. ' +
      'Shapes: `round` start/end, `diamond` decision, `cylinder` store, box for a step. Put conditions ' +
      'on edges (`label: "on timeout"`), `style: "dashed"` for conditional or async. Keep to the boxes ' +
      'that matter - forty is a wall, and the limit refuses rather than truncates.',
    parametersSchema: diagramSpecSchema,

    async execute(params): Promise<ToolResult> {
      const layout = layoutDiagram(params)
      const ranks = new Set(layout.nodes.map((node) => node.y)).size
      const unreachable = params.nodes.filter(
        (node) =>
          node.id !== params.nodes[0]?.id &&
          !params.edges.some((edge) => edge.to === node.id || edge.from === node.id),
      )

      /*
       * The model is told what was drawn, not handed the picture back.
       *
       * It already has the graph; echoing it spends context re-reading what it just sent. What it
       * does not know is whether the call was accepted and how the result came out — and one
       * thing it genuinely cannot see is a node it forgot to connect, which looks like a mistake
       * on screen and is invisible from the spec.
       */
      return {
        content: [
          `Drew a diagram${params.title === undefined ? '' : ` titled "${params.title}"`} with ` +
            `${String(params.nodes.length)} node(s) and ${String(params.edges.length)} edge(s), ` +
            `across ${String(ranks)} level(s), running ${params.direction ?? 'down'}.`,
          unreachable.length === 0
            ? ''
            : `${String(unreachable.length)} node(s) have no edges at all and float unconnected: ` +
              `${unreachable.map((node) => node.id).join(', ')}. Connect them or drop them.`,
          'The diagram is now in the conversation. Describe what it shows rather than listing the ' +
            'boxes again — they are on screen.',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      }
    },
  }
}
