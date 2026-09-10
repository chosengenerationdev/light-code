import { chartSpecSchema, chartTotals, type ChartSpec } from '../charts/types.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Draws a chart in the conversation.
 *
 * ## Why this is a tool rather than a message format
 *
 * The alternative was sniffing tool output for something chart-shaped and rendering it. That fails
 * the same way every implicit format does: a Python tool that happens to return `{categories,
 * series}` would suddenly draw a chart nobody asked for, and a tool that meant to draw one and got
 * a field name wrong would silently print JSON instead, with nothing to say why. An explicit call
 * is a decision, and a rejected call says what was wrong with it.
 *
 * ## Why it needs no approval
 *
 * It performs no work outside the panel — no file, no process, no request. It puts a picture of
 * numbers the model already has into the transcript, which is what assistant text does. Gating it
 * would train people to click through approvals that never matter, which is how the ones that do
 * matter stop being read.
 *
 * ## Why the chart is not the answer
 *
 * The result returned to the model is a summary of what was drawn, and the panel offers the
 * underlying table beside the picture. A chart is a way *into* data, not a replacement for it —
 * hence `detail` per point, so "which fourteen?" has an answer that does not need another search.
 */
export function createShowChartTool(): Tool<ChartSpec> {
  return {
    name: 'show_chart',
    // A control tool: it presents, it does not act. Never filtered out by a mode, never gated.
    group: 'always',
    description:
      'Draw a chart for the user: bar, stackedBar, groupedBar, line, multiLine or pie. Give ' +
      '`categories` (the x axis, or the pie slice labels) and one or more named `series`, each ' +
      'with one number per category. Use it whenever a set of numbers is easier seen than read — ' +
      'counts per folder or per day, a value trending over time, a breakdown of a total. ' +
      'Series lengths must match the categories exactly; a mismatch is refused rather than ' +
      'padded, because a chart drawn from misaligned data looks correct and is not. ' +
      'Add `detail` to a series to record what each number is made of (the subjects counted, the ' +
      'files measured) — the user can then open any point and see what went into it, which is ' +
      'what makes a chart worth drawing rather than a summary that hides the evidence. ' +
      'Say in `note` where the numbers came from and what they leave out.',
    parametersSchema: chartSpecSchema,

    async execute(params): Promise<ToolResult> {
      const totals = chartTotals(params)
      const detailed = params.series.filter((series) => series.detail !== undefined).length

      /*
       * The model is told what was drawn, not handed the chart back.
       *
       * It already has these numbers — echoing them would spend context re-reading what it just
       * sent. What it does not know is whether the call was accepted, and what the totals came to,
       * which is the part it is likely to want to say out loud next.
       */
      return {
        content: [
          `Drew a ${params.type} chart${params.title === undefined ? '' : ` titled "${params.title}"`} ` +
            `with ${String(params.categories.length)} categor(ies) and ${String(params.series.length)} series.`,
          ...totals.series.map((entry) => `  ${entry.name}: total ${String(entry.total)}`),
          detailed === 0
            ? 'No per-point detail was given, so the user cannot open a point to see what is behind ' +
              'it. Add `detail` when the numbers count things worth naming.'
            : `${String(detailed)} series carr(ies) per-point detail, so the user can open a point ` +
              'and see what went into it.',
          'The chart is now in the conversation. Describe what it shows rather than reciting the ' +
            'numbers again — they are on screen.',
        ].join('\n'),
      }
    },
  }
}
