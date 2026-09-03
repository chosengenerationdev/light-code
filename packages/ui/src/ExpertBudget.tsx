import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ExpertIcon } from './icons.js'
import { colors, fontFamily, secondaryButtonStyle, textFieldStyle } from './theme.js'

export interface ExpertBudgetProps {
  /** Dollars allowed in this chat. 0 means no limit. */
  maxSpendUsd: number
  /** Consultations allowed in this chat. 0 means no limit. */
  maxConsultations: number
  /** True when this chat is overriding the configured default. */
  overridden: boolean
  /** The expert's own guess at the whole task. A guess, and labelled as one. */
  estimate?: { consultations?: number; usd?: number }
  /** Spent so far, so the control can show how much of the ceiling is gone. */
  usd: number
  consultations: number
  /** 0..1 against the nearer limit; absent when nothing is capped. */
  usage?: number
  /** True once the expert has stopped being offered for this chat. */
  exhausted?: boolean
  /** Whether the expert is switched on and runnable. */
  enabled: boolean
  /**
   * The active mode.
   *
   * Kept for the label — a Junior-mode budget is the one being planned against, and saying so is
   * worth a word. It no longer decides *whether* the control appears: `ask_expert` is callable in
   * Code mode too, so hiding the ceiling there meant it could only be set after money had already
   * been spent under whatever default happened to apply.
   */
  modeId: string
  /** Omitting both clears the override and returns to the configured default. */
  onSetLimits: (limits: { maxSpendUsd?: number; maxConsultations?: number }) => void
}

/**
 * The expert's budget for this conversation, in the chat header.
 *
 * Beside the mode selector on purpose: choosing Junior mode and deciding what the expert may
 * spend are the same thought, and both belong to *this* conversation rather than to the
 * application. It was originally a figure on the cost meter above the composer, which was
 * technically in the chat window and in practice invisible — a small grey number near the
 * bottom does not read as a control.
 *
 * Settings → Expert still sets the default. This overrides it for one chat, applies to the very
 * next consultation, and is cleared when a new chat starts.
 */
export function ExpertBudget(props: ExpertBudgetProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [spend, setSpend] = useState(String(props.maxSpendUsd))
  const [calls, setCalls] = useState(String(props.maxConsultations))
  const wrapper = useRef<HTMLDivElement>(null)

  // The host is the authority: a limit changed in Settings, or cleared by a new chat, has to
  // land here rather than leaving stale numbers behind in a popover that happens to be shut.
  useEffect(() => {
    setSpend(String(props.maxSpendUsd))
    setCalls(String(props.maxConsultations))
  }, [props.maxSpendUsd, props.maxConsultations])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrapper.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /*
   * Shown wherever the expert can be consulted, which is every mode that has the tool.
   *
   * It used to appear in Junior mode only, and elsewhere just once money had already been spent.
   * That was the wrong way round: `ask_expert` is available in Code mode too, so the ceiling was
   * hidden precisely while it was still worth setting, and appeared only after the first
   * consultation had gone through under whatever limit happened to be configured.
   *
   * The number it starts from is the one saved in the Expert tab, so a limit set there is what
   * every conversation begins with, and changing it here changes it from then on.
   */
  if (!props.enabled) return null

  const numeric = (value: string): number => {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  const apply = (): void => {
    props.onSetLimits({ maxSpendUsd: numeric(spend), maxConsultations: Math.round(numeric(calls)) })
    setOpen(false)
  }

  const capped = props.maxSpendUsd > 0 || props.maxConsultations > 0
  const label = props.exhausted === true
    ? 'Raise budget'
    : capped
      ? [
          props.maxSpendUsd > 0 ? `$${props.maxSpendUsd.toFixed(2)}` : undefined,
          props.maxConsultations > 0 ? `${String(props.maxConsultations)}×` : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(' / ')
      : 'Budget'

  /* Amber before the wall, not only at it — the point is that someone notices in time. */
  const near = props.usage !== undefined && props.usage >= 0.8
  const tone = props.exhausted === true ? colors.error : near ? colors.warning : undefined

  return (
    <div ref={wrapper} style={{ position: 'relative', display: 'flex', fontFamily }}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          ...secondaryButtonStyle(),
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 11,
          padding: '2px 7px',
          ...(tone !== undefined ? { borderColor: tone, color: tone } : {}),
        }}
        title={
          props.exhausted === true
            ? 'The expert budget for this chat is spent. Raise it here and the next consultation goes ahead — no need to start a new chat.'
            : `Expert budget for this chat${props.overridden ? ' (overriding Settings)' : ''}. Spent so far: $${props.usd.toFixed(4)} over ${String(props.consultations)} consultation${props.consultations === 1 ? '' : 's'}.`
        }
        onClick={() => setOpen((value) => !value)}
      >
        <span style={{ display: 'flex', color: tone ?? colors.expert }}>
          <ExpertIcon size={11} />
        </span>
        <span>{label}</span>
        {props.overridden && props.exhausted !== true && <span aria-hidden>•</span>}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Expert budget for this chat"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 40,
            width: 236,
            padding: 8,
            borderRadius: 4,
            border: `1px solid ${colors.border}`,
            background: colors.inputBackground,
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.32)',
            color: colors.foreground,
            fontSize: 11,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <strong style={{ fontSize: 11 }}>Expert budget — this chat</strong>
          <span style={{ color: colors.muted }}>
            Spent ${props.usd.toFixed(4)} over {props.consultations}{' '}
            {props.consultations === 1 ? 'consultation' : 'consultations'}.
          </span>

          {/*
            The expert's estimate, offered with its plan. Labelled "estimates" and kept visually
            distinct from the spend above it: one is a measurement and the other is a model
            guessing about its own future behaviour, and conflating them would be dishonest
            about which number can be relied on.
          */}
          {props.estimate !== undefined && (
            <div
              style={{
                padding: '4px 6px',
                borderRadius: 3,
                border: `1px solid ${colors.border}`,
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ color: colors.expert }}>Expert estimates</span>
              <span style={{ color: colors.foreground }}>
                {[
                  props.estimate.usd === undefined ? undefined : `$${props.estimate.usd.toFixed(2)}`,
                  props.estimate.consultations === undefined
                    ? undefined
                    : `${String(props.estimate.consultations)} consultations`,
                ]
                  .filter((part) => part !== undefined)
                  .join(' over ')}
              </span>
              <button
                type="button"
                style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px', marginLeft: 'auto' }}
                title="Fill the fields below with the estimate. A little headroom is added, because an estimate that is exactly right still stops you at the last review."
                onClick={() => {
                  // 25% headroom: a budget set to the estimate exactly runs out on the final
                  // checkpoint, which is the worst moment to lose the expert.
                  if (props.estimate?.usd !== undefined) setSpend((props.estimate.usd * 1.25).toFixed(2))
                  if (props.estimate?.consultations !== undefined) {
                    setCalls(String(Math.ceil(props.estimate.consultations * 1.25)))
                  }
                }}
              >
                Use it
              </button>
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 66, color: colors.muted }}>Stop after</span>
            <input
              type="number"
              min="0"
              step="0.25"
              value={spend}
              aria-label="Maximum spend for this chat, in dollars"
              onChange={(event) => setSpend(event.target.value)}
              style={{ ...textFieldStyle(), flex: 1, fontSize: 11, padding: '2px 4px' }}
            />
            <span style={{ color: colors.muted }}>dollars</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 66, color: colors.muted }}>or after</span>
            <input
              type="number"
              min="0"
              step="1"
              value={calls}
              aria-label="Maximum consultations for this chat"
              onChange={(event) => setCalls(event.target.value)}
              style={{ ...textFieldStyle(), flex: 1, fontSize: 11, padding: '2px 4px' }}
            />
            <span style={{ color: colors.muted }}>calls</span>
          </label>

          <span style={{ color: colors.muted }}>
            0 means no limit. Applies to the next consultation — a new chat goes back to the
            default from Settings.
          </span>

          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '2px 8px' }} onClick={apply}>
              Apply
            </button>
            {props.overridden && (
              <button
                type="button"
                style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '2px 8px' }}
                title="Go back to the limit configured in Settings → Expert"
                onClick={() => {
                  props.onSetLimits({})
                  setOpen(false)
                }}
              >
                Use the default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
