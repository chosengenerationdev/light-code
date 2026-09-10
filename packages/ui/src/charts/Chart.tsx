import { useMemo, useState, type ReactElement } from 'react'
import { chartTotals, type ChartSpec, type ChartSeries } from '@light-code/core/browser'

import { colors } from '../theme.js'

/**
 * A chart, drawn as SVG with no library.
 *
 * ## Why hand-written
 *
 * The same reason the differ, the syntax highlighter and the PDF reader are hand-written here: the
 * webview runs under `default-src 'none'` with every asset bundled, so a charting library is bytes
 * every user downloads whether or not a chart is ever drawn — and the ones worth having are
 * hundreds of kilobytes. Six chart types over one data shape is a few hundred lines of geometry.
 *
 * ## The picture is never the only copy
 *
 * Every chart carries **Show numbers**, which prints the values it was drawn from, and any point
 * with `detail` can be opened to list what went into it. That is not a nicety: a chart is believed
 * precisely because nobody checks it, so the evidence has to be one click away rather than
 * somewhere else entirely. Same instinct as invariant 8 — show the ground truth, not a description
 * of it.
 *
 * ## Colours come from the accent
 *
 * Series colours are rotations of the user's own accent rather than a fixed palette, so a chart
 * belongs to the theme instead of fighting it, and stays legible on light and dark alike.
 */
export interface ChartProps {
  chart: ChartSpec
}

const WIDTH = 560
const HEIGHT = 260
const PAD = { top: 18, right: 14, bottom: 46, left: 52 }

const PLOT = {
  width: WIDTH - PAD.left - PAD.right,
  height: HEIGHT - PAD.top - PAD.bottom,
}

/**
 * Distinct colours derived from the accent.
 *
 * Hue rotation rather than a fixed list: the accent is user-chosen, so a hard-coded palette would
 * clash with it half the time. Lightness alternates as well, because hue alone is not enough to
 * separate adjacent series for someone who cannot distinguish them.
 */
function seriesColor(index: number, total: number): string {
  const spread = total <= 1 ? 0 : (index / total) * 300
  const lift = index % 2 === 0 ? 0 : 14
  return `hsl(from ${colors.accent} calc(h + ${String(spread)}) s calc(l + ${String(lift)}))`
}

/** A readable tick step — 1, 2 or 5 times a power of ten. */
function niceStep(range: number, targetTicks: number): number {
  if (range <= 0) return 1
  const rough = range / Math.max(1, targetTicks)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalised = rough / magnitude
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10
  return step * magnitude
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(Math.abs(value) < 1 ? 3 : 2).replace(/\.?0+$/, '')
}

/** Where the value axis starts and ends, and the gridlines between. */
function axisFor(values: number[], stacked: boolean, series: ChartSeries[], categories: number): {
  min: number
  max: number
  ticks: number[]
} {
  let max = 0
  let min = 0
  if (stacked) {
    for (let index = 0; index < categories; index++) {
      const sum = series.reduce((total, entry) => total + (entry.values[index] ?? 0), 0)
      max = Math.max(max, sum)
    }
  } else {
    max = Math.max(0, ...values)
    min = Math.min(0, ...values)
  }
  if (max === min) max = min + 1

  const step = niceStep(max - min, 4)
  const from = Math.floor(min / step) * step
  const to = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = from; value <= to + step / 2; value += step) ticks.push(Number(value.toFixed(10)))
  return { min: from, max: to, ticks }
}

/** A category label short enough to read, with the full text kept in a tooltip. */
function shortLabel(label: string, budget: number): string {
  return label.length <= budget ? label : `${label.slice(0, Math.max(1, budget - 1))}…`
}

interface Picked {
  series: string
  category: string
  value: number
  detail: string[] | undefined
}

export function Chart(props: ChartProps): ReactElement {
  const { chart } = props
  const [picked, setPicked] = useState<Picked | undefined>(undefined)
  const [showNumbers, setShowNumbers] = useState(false)

  const totals = useMemo(() => chartTotals(chart), [chart])
  const stacked = chart.type === 'stackedBar'
  const allValues = useMemo(() => chart.series.flatMap((series) => series.values), [chart])
  const axis = useMemo(
    () => axisFor(allValues, stacked, chart.series, chart.categories.length),
    [allValues, stacked, chart],
  )

  const pick = (series: ChartSeries, index: number): void => {
    const value = series.values[index] ?? 0
    const detail = series.detail?.[index] ?? undefined
    const category = chart.categories[index] ?? ''
    setPicked((current) =>
      current?.series === series.name && current.category === category
        ? undefined
        : { series: series.name, category, value, detail: detail === null ? undefined : detail },
    )
  }

  const y = (value: number): number =>
    PAD.top + PLOT.height - ((value - axis.min) / (axis.max - axis.min)) * PLOT.height

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: 10,
        margin: '8px 0',
        background: colors.inputBackground,
      }}
    >
      {chart.title !== undefined && (
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{chart.title}</div>
      )}

      {chart.series.length > 1 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '4px 0 6px' }}>
          {chart.series.map((series, index) => (
            <span key={series.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: seriesColor(index, chart.series.length),
                  flex: '0 0 auto',
                }}
              />
              {series.name}
            </span>
          ))}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        {chart.type === 'pie' ? (
          <PieChart chart={chart} onPick={pick} picked={picked} />
        ) : (
          <svg
            viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
            style={{ width: '100%', minWidth: 320, height: 'auto', display: 'block' }}
            role="img"
            aria-label={chart.title ?? `${chart.type} chart`}
          >
            {/* Gridlines and the value axis. Drawn first so nothing is painted over the data. */}
            {axis.ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + PLOT.width}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke={colors.border}
                  strokeWidth={tick === 0 ? 1.2 : 0.6}
                />
                <text x={PAD.left - 6} y={y(tick) + 3.5} textAnchor="end" fontSize={9} fill={colors.muted}>
                  {formatNumber(tick)}
                </text>
              </g>
            ))}

            {chart.type === 'line' || chart.type === 'multiLine' ? (
              <Lines chart={chart} y={y} onPick={pick} picked={picked} />
            ) : (
              <Bars chart={chart} y={y} zero={y(Math.max(axis.min, 0))} onPick={pick} picked={picked} />
            )}

            {/* Category labels, thinned when there are more than will fit rather than overlapped. */}
            {chart.categories.map((category, index) => {
              const every = Math.ceil(chart.categories.length / 12)
              if (index % every !== 0) return null
              const slot = PLOT.width / chart.categories.length
              const cx = PAD.left + slot * index + slot / 2
              return (
                <text
                  key={category + String(index)}
                  x={cx}
                  y={HEIGHT - PAD.bottom + 14}
                  textAnchor="middle"
                  fontSize={9}
                  fill={colors.muted}
                >
                  <title>{category}</title>
                  {shortLabel(category, 12)}
                </text>
              )
            })}

            {chart.xLabel !== undefined && (
              <text x={PAD.left + PLOT.width / 2} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill={colors.muted}>
                {chart.xLabel}
              </text>
            )}
            {chart.yLabel !== undefined && (
              <text
                x={-(PAD.top + PLOT.height / 2)}
                y={11}
                transform="rotate(-90)"
                textAnchor="middle"
                fontSize={10}
                fill={colors.muted}
              >
                {chart.yLabel}
              </text>
            )}
          </svg>
        )}
      </div>

      {/*
        The evidence, one click away.

        A chart is trusted because nobody checks it against the data — so the data has to be here
        rather than somewhere else. `picked` answers "which ones?" for a single point; Show numbers
        answers it for the whole chart.
      */}
      {picked !== undefined && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            fontSize: 11,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {picked.category}
            {chart.series.length > 1 ? ` — ${picked.series}` : ''}: {formatNumber(picked.value)}
          </div>
          {picked.detail === undefined || picked.detail.length === 0 ? (
            <div style={{ color: colors.muted, marginTop: 4 }}>
              No detail was recorded for this point, so what went into it is not known here.
            </div>
          ) : (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: colors.muted }}>
              {picked.detail.slice(0, 50).map((line, index) => (
                <li key={String(index) + line}>{line}</li>
              ))}
              {picked.detail.length > 50 && <li>{`…and ${String(picked.detail.length - 50)} more`}</li>}
            </ul>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={{
            background: 'none',
            border: 'none',
            color: colors.accent,
            cursor: 'pointer',
            padding: 0,
            fontSize: 11,
          }}
          onClick={() => setShowNumbers((current) => !current)}
        >
          {showNumbers ? 'Hide numbers' : 'Show numbers'}
        </button>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          {chart.series.length === 1
            ? `Total ${formatNumber(totals.grand)}`
            : totals.series.map((entry) => `${entry.name} ${formatNumber(entry.total)}`).join(' · ')}
        </span>
      </div>

      {showNumbers && (
        <div className="lc-scroll" style={{ overflowX: 'auto', marginTop: 6 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={cellStyle(true)}>{chart.xLabel ?? ''}</th>
                {chart.series.map((series) => (
                  <th key={series.name} style={cellStyle(true)}>
                    {series.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.categories.map((category, index) => (
                <tr key={category + String(index)}>
                  <td style={cellStyle(false)}>{category}</td>
                  {chart.series.map((series) => (
                    <td key={series.name} style={{ ...cellStyle(false), textAlign: 'right' }}>
                      {formatNumber(series.values[index] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {chart.note !== undefined && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 6 }}>{chart.note}</div>
      )}
    </div>
  )
}

function cellStyle(header: boolean): React.CSSProperties {
  return {
    border: `1px solid ${colors.border}`,
    padding: '2px 6px',
    textAlign: header ? 'left' : 'left',
    color: header ? colors.foreground : colors.muted,
    whiteSpace: 'nowrap',
  }
}

/** Bars: plain, stacked or grouped. One geometry, three ways of dividing the slot. */
function Bars(props: {
  chart: ChartSpec
  y: (value: number) => number
  zero: number
  onPick: (series: ChartSeries, index: number) => void
  picked: Picked | undefined
}): ReactElement {
  const { chart } = props
  const slot = PLOT.width / chart.categories.length
  const inner = slot * 0.72
  const grouped = chart.type === 'groupedBar' && chart.series.length > 1
  const bandWidth = grouped ? inner / chart.series.length : inner

  return (
    <g>
      {chart.categories.map((category, index) => {
        const left = PAD.left + slot * index + (slot - inner) / 2
        let stackTop = props.zero

        return (
          <g key={category + String(index)}>
            {chart.series.map((series, seriesIndex) => {
              const value = series.values[index] ?? 0
              const color = seriesColor(seriesIndex, chart.series.length)
              const isPicked = props.picked?.series === series.name && props.picked.category === category

              let x: number
              let top: number
              let height: number

              if (chart.type === 'stackedBar') {
                height = Math.abs(props.zero - props.y(value)) || 0
                top = stackTop - height
                stackTop = top
                x = left
              } else {
                x = grouped ? left + bandWidth * seriesIndex : left
                const yValue = props.y(value)
                top = Math.min(yValue, props.zero)
                height = Math.abs(yValue - props.zero)
              }

              return (
                <rect
                  key={series.name}
                  x={x}
                  y={top}
                  width={Math.max(1, bandWidth - (grouped ? 1 : 0))}
                  height={Math.max(0, height)}
                  fill={color}
                  opacity={props.picked === undefined || isPicked ? 1 : 0.45}
                  style={{ cursor: 'pointer' }}
                  onClick={() => props.onPick(series, index)}
                >
                  <title>{`${category} — ${series.name}: ${formatNumber(value)}`}</title>
                </rect>
              )
            })}
          </g>
        )
      })}
    </g>
  )
}

/** Lines, with a dot per point so a single-point series is still visible. */
function Lines(props: {
  chart: ChartSpec
  y: (value: number) => number
  onPick: (series: ChartSeries, index: number) => void
  picked: Picked | undefined
}): ReactElement {
  const { chart } = props
  const slot = PLOT.width / chart.categories.length
  const x = (index: number): number => PAD.left + slot * index + slot / 2

  return (
    <g>
      {chart.series.map((series, seriesIndex) => {
        const color = seriesColor(seriesIndex, chart.series.length)
        const points = series.values.map((value, index) => `${String(x(index))},${String(props.y(value))}`).join(' ')
        return (
          <g key={series.name}>
            <polyline points={points} fill="none" stroke={color} strokeWidth={1.8} />
            {series.values.map((value, index) => {
              const category = chart.categories[index] ?? ''
              const isPicked = props.picked?.series === series.name && props.picked.category === category
              return (
                <circle
                  key={String(index)}
                  cx={x(index)}
                  cy={props.y(value)}
                  r={isPicked ? 4.5 : 2.6}
                  fill={color}
                  style={{ cursor: 'pointer' }}
                  onClick={() => props.onPick(series, index)}
                >
                  <title>{`${category} — ${series.name}: ${formatNumber(value)}`}</title>
                </circle>
              )
            })}
          </g>
        )
      })}
    </g>
  )
}

/** A pie, from one series. Slices are drawn as arcs; a single slice becomes a full circle. */
function PieChart(props: {
  chart: ChartSpec
  onPick: (series: ChartSeries, index: number) => void
  picked: Picked | undefined
}): ReactElement {
  const series = props.chart.series[0]
  const values = series?.values ?? []
  const total = values.reduce((sum, value) => sum + value, 0)
  const size = 230
  const radius = 92
  const cx = size / 2
  const cy = size / 2

  return (
    <svg
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      style={{ width: 240, maxWidth: '100%', height: 'auto', display: 'block' }}
      role="img"
      aria-label={props.chart.title ?? 'pie chart'}
    >
      {total === 0 ? (
        <text x={cx} y={cy} textAnchor="middle" fontSize={11} fill={colors.muted}>
          Every value is zero
        </text>
      ) : (
        (() => {
          let angle = -Math.PI / 2
          return props.chart.categories.map((category, index) => {
            const value = values[index] ?? 0
            const sweep = (value / total) * Math.PI * 2
            const color = seriesColor(index, props.chart.categories.length)
            const isPicked = props.picked?.category === category
            const start = angle
            angle += sweep

            // A single non-zero slice is the whole circle; an arc path cannot express 360 degrees.
            if (sweep >= Math.PI * 2 - 1e-9) {
              return (
                <circle
                  key={category + String(index)}
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill={color}
                  style={{ cursor: 'pointer' }}
                  onClick={() => series !== undefined && props.onPick(series, index)}
                >
                  <title>{`${category}: ${formatNumber(value)}`}</title>
                </circle>
              )
            }

            const x1 = cx + radius * Math.cos(start)
            const y1 = cy + radius * Math.sin(start)
            const x2 = cx + radius * Math.cos(angle)
            const y2 = cy + radius * Math.sin(angle)
            const large = sweep > Math.PI ? 1 : 0

            return (
              <path
                key={category + String(index)}
                d={`M ${String(cx)} ${String(cy)} L ${String(x1)} ${String(y1)} A ${String(radius)} ${String(radius)} 0 ${String(large)} 1 ${String(x2)} ${String(y2)} Z`}
                fill={color}
                opacity={props.picked === undefined || isPicked ? 1 : 0.45}
                style={{ cursor: 'pointer' }}
                onClick={() => series !== undefined && props.onPick(series, index)}
              >
                <title>{`${category}: ${formatNumber(value)} (${((value / total) * 100).toFixed(1)}%)`}</title>
              </path>
            )
          })
        })()
      )}
    </svg>
  )
}
