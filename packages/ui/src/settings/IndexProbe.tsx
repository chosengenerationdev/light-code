import { useState, type ReactElement } from 'react'
import type { ProbeTarget } from '@light-code/core/browser'

import { colors, secondaryButtonStyle, textFieldStyle } from '../theme.js'

export interface IndexProbeProps {
  target: ProbeTarget
  label: string
  hint: string
  running: boolean
  result: { query: string; text: string; error?: string } | undefined
  onProbe: (query: string, target: ProbeTarget) => void
}

/**
 * Running a search by hand, against the index the assistant would search.
 *
 * ## Why it is worth a control of its own
 *
 * An index is invisible. "It found nothing" and "there is nothing indexed" and "the embedding
 * model is wrong" all look identical from the chat, and the only way to tell them apart is to ask
 * the index something you already know the answer to. This existed for the codebase and for tool
 * documentation, in the Search tab — but it was reachable only by someone who already knew it was
 * there, which is the same complaint that moved every other control to where the thing lives.
 *
 * **It runs the real tool, never a re-implementation.** The whole point is to show what the
 * assistant would get; a second query path could disagree with the real one and would be believed.
 */
export function IndexProbe(props: IndexProbeProps): ReactElement {
  const [query, setQuery] = useState('')

  const run = (): void => {
    if (query.trim().length > 0) props.onProbe(query.trim(), props.target)
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="text"
          value={query}
          spellCheck={false}
          placeholder={props.label}
          aria-label={props.label}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') run()
          }}
          style={{ ...textFieldStyle(), flex: 1 }}
        />
        <button type="button" style={secondaryButtonStyle()} disabled={props.running} onClick={run}>
          {props.running ? 'Searching…' : 'Search'}
        </button>
      </div>
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>{props.hint}</span>

      {props.result !== undefined && (
        <div style={{ marginTop: 8 }}>
          {props.result.error !== undefined && (
            <span style={{ display: 'block', color: colors.error, fontSize: 11 }}>{props.result.error}</span>
          )}
          {/*
            The tool's own output, verbatim and unparsed. Reformatting it here would mean this
            panel could show something different from what the model was handed, which is the one
            thing it exists not to do.
          */}
          <pre
            className="lc-scroll"
            style={{
              margin: 0,
              maxHeight: 260,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontSize: 11,
              color: colors.foreground,
              background: colors.inputBackground,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              padding: 8,
            }}
          >
            {props.result.text}
          </pre>
        </div>
      )}
    </div>
  )
}
