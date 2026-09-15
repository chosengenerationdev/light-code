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
    description:
      'Draw a technical diagram for the user: a flow chart, an architecture sketch, a sequence ' +
      'of steps, a state machine. Give `nodes` (each with an `id` and a `label`) and `edges` ' +
      'between those ids — the layout is worked out for you, so do not attempt coordinates. ' +
      'Use it when a structure is easier seen than described: how a request travels, what calls ' +
      'what, where a decision branches, what happens on failure. ' +
      'Shapes carry the usual meanings — `round` for a start or end, `diamond` for a decision, ' +
      '`cylinder` for a store, and the default box for a step. Put the condition on the edge ' +
      '(`label: "yes"`, `label: "on timeout"`) rather than inventing a node for it, and use ' +
      '`style: "dashed"` for anything conditional, asynchronous or secondary. ' +
      'Tone colours a box by meaning — success, danger, warning, info, accent, muted — and `icon` ' +
      'puts a glyph in its corner. `emphasis: "bold"` for the box the diagram is really about, ' +
      '`font: "mono"` where the label *is* an identifier (a path, a function, a table). ' +
      '`textSize` is small, normal, large or xlarge, on a node for one box or on the diagram for ' +
      'all of them — use it when the user asks for bigger or smaller text, which they may well ' +
      'do; the box grows with the text so nothing is cut off. ' +
      'A `legend` explains what a colour or a shape stands for *in this diagram*, which is worth ' +
      'giving whenever the meaning is not obvious from the labels. ' +
      '`direction: "right"` suits a pipeline; the default runs downwards and suits most flows. ' +
      'Loops are fine — an edge pointing back is drawn round the outside. ' +
      'Keep it to the boxes that earn their place: a diagram of forty is a wall, not an ' +
      'explanation, and the limit is a refusal rather than a truncation.',
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
