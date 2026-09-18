import { DISPLAY_SIZES, DISPLAY_SIZE_DESCRIPTION } from '../display/size.js'
import { z } from 'zod'

/**
 * A chart the assistant can put in the transcript.
 *
 * ## One shape for every kind
 *
 * Categories along one axis, one or more named series of numbers against them. A pie is that with
 * a single series; a stacked bar is that with several summed; a multi-line is that with several
 * drawn. Six chart types out of one structure, rather than six schemas the model has to choose
 * between correctly before it has even chosen the chart.
 *
 * ## Why the validation is strict rather than forgiving
 *
 * **A chart that renders is believed.** Nobody audits a bar against the numbers behind it — that
 * is the entire reason to draw one. So a series whose length does not match the categories is
 * *rejected*, never padded or truncated: padding produces a chart that looks correct and says
 * something false, which is worse than no chart at all. Same reasoning as invariant 8, and the
 * same reasoning as §7's refusal to fuzzy-match a diff.
 *
 * ## Why the numbers travel with it
 *
 * The rendered chart is a picture of `values`, and `values` is what the UI also offers as a table.
 * There is no second copy and no transformation in between, so the picture cannot drift from the
 * figures — the drift between two stored views of one thing is what §6b and §15 are both about.
 */
export const CHART_TYPES = ['bar', 'stackedBar', 'groupedBar', 'line', 'multiLine', 'pie'] as const
export type ChartType = (typeof CHART_TYPES)[number]

/** How many categories and series are worth drawing before a chart stops being readable. */
export const MAX_CATEGORIES = 200
export const MAX_SERIES = 12

const finiteNumber = z
  .number()
  .refine((value) => Number.isFinite(value), { message: 'must be a finite number' })

export const chartSeriesSchema = z.object({
  name: z.string().min(1).describe('What this series is, e.g. "Alerts" or "Inbox". Shown in the legend.'),
  values: z
    .array(finiteNumber)
    .min(1)
    .max(MAX_CATEGORIES)
    .describe('One number per category, in the same order as `categories`.'),
  /**
   * What each number is made of, for the reader who asks "which ones?".
   *
   * Aligned with `values` by index, and any entry may be omitted. This is the drill-down: a bar
   * showing 14 alerts can list the fourteen subjects, so the chart is a way *into* the data rather
   * than a summary that replaces it.
   */
  detail: z
    .array(z.union([z.array(z.string()), z.null()]))
    .max(MAX_CATEGORIES)
    .optional()
    .describe(
      'Optional. For each value, the rows behind it — subjects, ids, filenames, whatever the ' +
        'number counted. Same order as `values`; use null where there is nothing to show.',
    ),
})
export type ChartSeries = z.infer<typeof chartSeriesSchema>

export const chartSpecSchema = z
  .object({
    type: z.enum(CHART_TYPES).describe('bar, stackedBar, groupedBar, line, multiLine or pie.'),
    title: z.string().max(200).optional(),
    categories: z
      .array(z.string())
      .min(1)
      .max(MAX_CATEGORIES)
      .describe('The x axis, or the pie slice labels. One per value in every series.'),
    series: z.array(chartSeriesSchema).min(1).max(MAX_SERIES),
    /** See `display/size.ts` — the same field and the same words as a diagram's. */
    size: z.enum(DISPLAY_SIZES).optional().describe(DISPLAY_SIZE_DESCRIPTION),
    xLabel: z.string().max(80).optional(),
    yLabel: z.string().max(80).optional(),
    note: z
      .string()
      .max(500)
      .optional()
      .describe('A line under the chart. Say where the numbers came from, and what they exclude.'),
  })
  .superRefine((spec, context) => {
    for (const [index, series] of spec.series.entries()) {
      if (series.values.length !== spec.categories.length) {
        context.addIssue({
          code: 'custom',
          path: ['series', index, 'values'],
          /*
           * Refused rather than padded, and the message says the counts.
           *
           * A silently padded series draws a chart that is the right shape and the wrong answer,
           * and nobody checks a chart against its data — that is what a chart is for. Being told
           * the two numbers is also what lets the model fix it in one turn.
           */
          message:
            `series "${series.name}" has ${String(series.values.length)} value(s) but there are ` +
            `${String(spec.categories.length)} categories. They must match exactly — a chart drawn ` +
            'from misaligned data looks correct and is not.',
        })
      }
      if (series.detail !== undefined && series.detail.length > series.values.length) {
        context.addIssue({
          code: 'custom',
          path: ['series', index, 'detail'],
          message: `series "${series.name}" has more detail entries than values.`,
        })
      }
    }

    if (spec.type === 'pie') {
      if (spec.series.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['series'],
          message: 'a pie chart takes exactly one series — use stackedBar or groupedBar for several.',
        })
      }
      if (spec.series.some((series) => series.values.some((value) => value < 0))) {
        context.addIssue({
          code: 'custom',
          path: ['series'],
          // A negative slice has no meaning: it cannot be drawn, and drawing its absolute value
          // would misreport the total every other slice is measured against.
          message: 'a pie chart cannot show negative values.',
        })
      }
    }

    if (spec.type === 'stackedBar' && spec.series.some((series) => series.values.some((value) => value < 0))) {
      context.addIssue({
        code: 'custom',
        path: ['series'],
        message: 'a stacked bar cannot show negative values — the segments would overlap rather than stack.',
      })
    }
  })

export type ChartSpec = z.infer<typeof chartSpecSchema>

/**
 * The totals a reader would otherwise work out by hand.
 *
 * Computed here rather than in the UI so the chat, a restored transcript and anything built later
 * cannot disagree about what a chart adds up to.
 */
export function chartTotals(spec: ChartSpec): { series: { name: string; total: number }[]; grand: number } {
  const series = spec.series.map((entry) => ({
    name: entry.name,
    total: entry.values.reduce((sum, value) => sum + value, 0),
  }))
  return { series, grand: series.reduce((sum, entry) => sum + entry.total, 0) }
}
