import type { ExpertSavings, SavingsWindow } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { colors } from '../theme.js'

export interface SavingsPanelProps {
  savings: ExpertSavings | undefined
}

/**
 * What Junior mode has cost, and what it has avoided, over three windows.
 *
 * ## The line this must not cross
 *
 * A big green "saved $412" would be the most persuasive thing in the product and the least
 * defensible. Nothing can know what the task would have cost had the strong model done all of
 * it. So every figure here is a **floor** built from prices measured on this machine, it is
 * labelled "at least", and the working is on the page — because a number whose derivation is
 * hidden is a number nobody can check, and this one is about money.
 *
 * ## Why it says nothing at all until the price is measured
 *
 * With no measurement the only honest answer is "unknown". Zero would read as "this saved you
 * nothing", which is a claim, and the wrong one — so the panel shows what it *has* counted and
 * says which button turns it into money.
 */
export function SavingsPanel(props: SavingsPanelProps): ReactElement | null {
  const [showWorking, setShowWorking] = useState(false)
  const savings = props.savings
  if (savings === undefined) return null

  /*
   * Rendered even with nothing recorded, deliberately.
   *
   * The first version hid itself until there was something to show, which meant someone who
   * went looking for the figures found *nothing at all* — indistinguishable from the feature
   * being broken, and reported exactly that way. An empty state that says what will fill it is
   * the whole difference between "not here" and "not yet".
   */
  const nothingYet = savings.allTime.consultations === 0 && savings.allTime.juniorTurns === 0

  return (
    <div
      style={{
        margin: '16px 0 0',
        padding: 12,
        borderRadius: 6,
        border: `1px solid ${colors.accent}`,
        // Tinted rather than filled: this has to be findable at a glance without turning into
        // the loudest thing in a settings panel.
        background: `color-mix(in srgb, ${colors.accent} 10%, transparent)`,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Junior mode</div>
      <div style={{ color: colors.muted, fontSize: 11, marginBottom: 10 }}>
        {nothingYet
          ? 'Nothing recorded yet. This fills in as you work in Junior mode — one entry per turn the cheap model handles alone, and one per consultation.'
          : savings.measured
            ? 'A floor, not an estimate — every figure below is at least this much.'
            : 'Counted, but not yet priced. Measure a consultation above to see this in money.'}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Metric label="Today" window={savings.today} measured={savings.measured} />
        <Metric label="Last 30 days" window={savings.last30Days} measured={savings.measured} />
        <Metric label="All time" window={savings.allTime} measured={savings.measured} />
      </div>

      <button
        type="button"
        onClick={() => setShowWorking((current) => !current)}
        style={{
          marginTop: 10,
          padding: 0,
          background: 'none',
          border: 'none',
          color: colors.accent,
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 11,
          textDecoration: 'underline',
        }}
      >
        {showWorking ? 'Hide how this is worked out' : 'How is this worked out?'}
      </button>

      {showWorking && <Working savings={savings} />}

      {nothingYet && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '8px 0 0' }}>
          Switch the mode selector in the chat header to <strong>Junior</strong> to start. Turns
          taken before this version was installed were never recorded, so the count begins now.
        </p>
      )}
    </div>
  )
}

function Metric(props: { label: string; window: SavingsWindow; measured: boolean }): ReactElement {
  const { window: data } = props
  return (
    <div
      style={{
        flex: '1 1 140px',
        minWidth: 140,
        padding: '8px 10px',
        borderRadius: 4,
        background: colors.inputBackground,
        border: `1px solid ${colors.border}`,
      }}
    >
      <div style={{ color: colors.muted, fontSize: 11 }}>{props.label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: colors.accent, lineHeight: 1.3 }}>
        {props.measured && data.avoidedUsd !== undefined ? `≥ ${money(data.avoidedUsd)}` : '—'}
      </div>
      <div style={{ color: colors.muted, fontSize: 11 }}>avoided</div>
      <div style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
        Spent {money(data.spentUsd)}
        {data.unpriced > 0 && ` + ${String(data.unpriced)} unpriced`}
      </div>
      <div style={{ color: colors.muted, fontSize: 11 }}>
        {plural(data.juniorTurns, 'junior turn')}, {plural(data.consultations, 'consultation')}
        {/* Keep-alive pings and price measurements. Their money is in "Spent" above; naming them
            separately is what stops that figure looking like it disagrees with the count. */}
        {data.overheadCalls > 0 && ` + ${String(data.overheadCalls)} upkeep`}
      </div>
    </div>
  )
}

/**
 * The derivation, in full.
 *
 * Written out rather than summarised because the reader's fair question is "where did that
 * come from", and the answer involves two components and one deliberate omission. Anything
 * shorter would need trusting.
 */
function Working(props: { savings: ExpertSavings }): ReactElement {
  const all = props.savings.allTime
  return (
    <div style={{ color: colors.muted, fontSize: 11, marginTop: 8, lineHeight: 1.55 }}>
      <p style={{ margin: '0 0 6px' }}>
        Two things are counted, and both are priced from the measurement taken on this machine —
        never from published rates.
      </p>
      <ol style={{ margin: '0 0 6px', paddingLeft: 18 }}>
        <li>
          <strong>Turns the expert never saw.</strong> Every turn the cheap model handled alone is
          one the expert would otherwise have taken. Each is priced at the cost of a{' '}
          <em>minimal</em> resumed consultation, which is the cheapest an expert turn can possibly
          be — so real work would have cost more. All time: {plural(all.juniorTurns, 'turn')}.
        </li>
        <li>
          <strong>Cold starts avoided.</strong> A consultation that resumed a live session instead
          of starting a new one saved the difference between the two measured prices. All time:{' '}
          {plural(all.consultations, 'consultation')}, of which the resumed ones count.
        </li>
      </ol>
      <p style={{ margin: '0 0 6px' }}>
        <strong>What is deliberately not counted:</strong> what the strong model would have charged
        to do the work itself. Nothing here can know that, so no multiplier is applied — which is
        why the total is a floor and says <em>at least</em>. The real saving is larger by an amount
        this panel refuses to guess at.
      </p>
      <p style={{ margin: 0 }}>
        Consultations the plan reported no price for are counted separately rather than as zero, so
        a total never looks exact while being incomplete. Events older than a year are dropped.
      </p>
    </div>
  )
}

function money(usd: number): string {
  if (usd === 0) return '$0'
  // Two decimals hide everything below a cent, and single consultations here cost well under
  // one — so small totals keep the precision that makes them meaningful.
  return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}
