import { GUIDE_STEPS, type GuideStep } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { MarkdownView } from '../MarkdownView.js'
import { colors, fontFamily, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'

export interface GuideProps {
  /** Takes the reader to a settings tab — the whole reason this is a tour rather than a page. */
  onOpenTab: (tab: string) => void
  /** Back to the chat. */
  onClose: () => void
  /**
   * Where the diagrams are served from, without a trailing slash.
   *
   * Supplied by the host rather than assumed, because only the host knows: the browser serves
   * them from its own origin, and a host with none at all passes nothing and gets a readable
   * text-only tour instead of fourteen broken images.
   */
  mediaBase?: string | undefined
}

/**
 * The guided tour, rendered in-app.
 *
 * VS Code has a Get Started page and this is not it — the browser host has no such thing, so an
 * `npx` user landed on an empty chat with no provider, no onboarding and no clue that eleven
 * settings tabs existed. The content is shared (`GUIDE_STEPS` in core) so the two hosts cannot
 * drift; only the rendering differs, and the difference is real: VS Code gets command links and
 * per-step completion from editor state, this gets buttons and a position counter.
 *
 * One step at a time rather than a long scroll. A tour that shows everything at once is a
 * document, and a document is the thing that was already failing to get read.
 */
export function Guide(props: GuideProps): ReactElement {
  const [index, setIndex] = useState(0)
  const step: GuideStep = GUIDE_STEPS[index] ?? GUIDE_STEPS[0]!
  const isFirst = index === 0
  const isLast = index === GUIDE_STEPS.length - 1

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontFamily,
        fontSize: 13,
        color: colors.foreground,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 13 }}>{step.title}</strong>
        <span style={{ marginLeft: 'auto', color: colors.muted, fontSize: 11 }}>
          {index + 1} of {GUIDE_STEPS.length}
        </span>
        <button type="button" style={{ ...secondaryButtonStyle(), fontSize: 11 }} onClick={props.onClose}>
          Close
        </button>
      </div>

      <div className="lc-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
        {props.mediaBase !== undefined && (
          /*
           * A <picture> rather than JS, so the diagram follows the theme with no listener to
           * leak and no flash of the wrong palette on first paint. The browser host's own CSS
           * switches on `prefers-color-scheme`, so this matches it exactly.
           */
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={`${props.mediaBase}/${step.id}-dark.svg`} />
            <img
              src={`${props.mediaBase}/${step.id}-light.svg`}
              alt={step.altText}
              style={{
                display: 'block',
                width: '100%',
                maxWidth: '100%',
                height: 'auto',
                borderRadius: 6,
                border: `1px solid ${colors.border}`,
                marginBottom: 12,
              }}
            />
          </picture>
        )}

        {step.body.map((paragraph, position) => (
          <div key={position} style={{ marginBottom: 10, lineHeight: 1.5 }}>
            <MarkdownView text={paragraph} />
          </div>
        ))}

        {step.tab !== undefined && (
          <button
            type="button"
            style={{ ...primaryButtonStyle(false), marginTop: 4 }}
            onClick={() => props.onOpenTab(step.tab as string)}
          >
            Open the {step.tab[0]?.toUpperCase()}
            {step.tab.slice(1)} tab
          </button>
        )}

        {step.tab === undefined && step.opensPanel === true && (
          <button type="button" style={{ ...secondaryButtonStyle(), marginTop: 4 }} onClick={props.onClose}>
            Back to the chat
          </button>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderTop: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={isFirst}
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
        >
          Back
        </button>
        {/*
          Dots rather than a scrollbar: fourteen steps is enough that "how much is left" is a
          real question, and the counter above answers it only once you look for it.
        */}
        <div style={{ display: 'flex', gap: 4, flex: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
          {GUIDE_STEPS.map((entry, position) => (
            <button
              key={entry.id}
              type="button"
              aria-label={entry.title}
              title={entry.title}
              onClick={() => setIndex(position)}
              style={{
                width: 7,
                height: 7,
                padding: 0,
                borderRadius: '50%',
                border: 'none',
                cursor: 'pointer',
                background: position === index ? colors.accent : colors.border,
              }}
            />
          ))}
        </div>
        {isLast ? (
          <button type="button" style={primaryButtonStyle(false)} onClick={props.onClose}>
            Done
          </button>
        ) : (
          <button
            type="button"
            style={primaryButtonStyle(false)}
            onClick={() => setIndex((current) => Math.min(GUIDE_STEPS.length - 1, current + 1))}
          >
            Next
          </button>
        )}
      </div>
    </div>
  )
}
