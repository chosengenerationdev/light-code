import type { SearchLogEntry } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { Select } from '../Select.js'
import { badgeStyle, colors, fontFamily, labelStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface SearchActivityProps {
  entries: SearchLogEntry[]
  probe: { query: string; text: string; error?: string } | undefined
  probeRunning: boolean
  onProbe: (query: string, target: 'codebase' | 'docs') => void
  /** Empties the recent-searches log. */
  onClear: () => void
  /** Dismisses the result of the last hand-run query. Separate from the log above it. */
  onClearProbe: () => void
}

/**
 * What the model has been searching for, and a box to try a query yourself.
 *
 * ## Why this needs to exist
 *
 * Retrieval is the one part of the product that fails *quietly*. A tool that errors says so in
 * the transcript; a vector search that returns confident neighbours for a query it did not
 * understand looks exactly like a search that worked. The only way to judge it is to see the
 * queries and what came back.
 *
 * It also surfaces the distinction the model cannot see: whether a `search_docs` result came
 * from the index or from the lexical fallback, because the store was unreachable or never
 * configured. Those are indistinguishable in the chat and very different in quality.
 *
 * The probe runs the **same** code path the model does — `runDocsSearch` was split out of the
 * tool precisely so this cannot drift. A panel that approximated the real search would prove
 * something, just not the thing being debugged.
 */
export function SearchActivity(props: SearchActivityProps): ReactElement {
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<'codebase' | 'docs'>('docs')

  const run = (): void => {
    if (query.trim().length > 0) props.onProbe(query.trim(), target)
  }

  return (
    <section style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
      <span style={labelStyle()}>Try a query</span>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        Runs through the same path the model uses, so what you see here is what it would have been
        given. Nothing is sent to the model.
      </p>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <Select
          compact
          value={target}
          ariaLabel="What to search"
          onChange={(value) => setTarget(value as 'codebase' | 'docs')}
          options={[
            { value: 'docs', label: 'Tools & skills' },
            { value: 'codebase', label: 'Codebase' },
          ]}
        />
        <input
          type="text"
          value={query}
          spellCheck={false}
          aria-label="Query"
          placeholder="e.g. where do we upload a report"
          // Enter runs it: this is a search box, and reaching for the button every time
          // makes trying five phrasings tedious enough that nobody tries five.
          onKeyDown={(event) => {
            if (event.key === 'Enter') run()
          }}
          onChange={(event) => setQuery(event.target.value)}
          style={{ ...textFieldStyle(), flex: 1, minWidth: 160 }}
        />
        <button type="button" style={secondaryButtonStyle()} disabled={props.probeRunning} onClick={run}>
          {props.probeRunning ? 'Searching…' : 'Search'}
        </button>
      </div>

      {props.probe !== undefined && (
        <div style={{ marginBottom: 12 }}>
          {/*
            Its own dismiss, separate from the Clear on the log below. A result can be several
            hundred lines and stays until something replaces it — which, if the next thing you
            do is read the log, means scrolling past an answer you have finished with.
          */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: colors.muted, fontSize: 11 }}>
              Result for “{props.probe.query}”
            </span>
            <button
              type="button"
              style={{ ...secondaryButtonStyle(), marginLeft: 'auto', fontSize: 10, padding: '1px 6px' }}
              title="Dismiss this result. The query stays in the log below."
              onClick={props.onClearProbe}
            >
              Clear result
            </button>
          </div>
          {props.probe.error !== undefined && (
            <p style={{ color: colors.error, fontSize: 11, margin: '0 0 4px' }}>{props.probe.error}</p>
          )}
          {props.probe.text.length > 0 && (
            <pre
              className="lc-scroll"
              style={{
                margin: 0,
                padding: 8,
                maxHeight: 260,
                overflow: 'auto',
                background: colors.inputBackground,
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                fontFamily: monospace,
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {props.probe.text}
            </pre>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={labelStyle()}>Recent searches</span>
        {props.entries.length > 0 && (
          <button
            type="button"
            style={{ ...secondaryButtonStyle(), marginLeft: 'auto', fontSize: 11 }}
            onClick={props.onClear}
          >
            Clear
          </button>
        )}
      </div>

      {props.entries.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 11, margin: 0 }}>
          Nothing yet. Searches the model runs — and any you try above — appear here.
        </p>
      ) : (
        <div className="lc-scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {props.entries.map((entry, index) => (
            <div
              key={`${String(entry.at)}-${String(index)}`}
              style={{ padding: '6px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 11 }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: monospace, color: colors.accent }}>{entry.source}</span>
                {/*
                  The most valuable badge on the panel: it is the only place a configured but
                  unused index becomes visible, since a lexical result reads identically to a
                  semantic one in the chat.
                */}
                {entry.via !== undefined && (
                  <span
                    style={{ ...badgeStyle(entry.via === 'lexical' ? 'warning' : 'neutral'), fontSize: 9 }}
                    title={
                      entry.via === 'index'
                        ? 'Matched by meaning, using the vector index'
                        : 'Matched on names and descriptions — the index was not used'
                    }
                  >
                    {entry.via === 'index' ? 'semantic' : 'lexical'}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {entry.hits} {entry.hits === 1 ? 'hit' : 'hits'} · {entry.elapsedMs}ms
                </span>
              </div>
              <div style={{ marginTop: 2, wordBreak: 'break-word' }}>{entry.query}</div>
              {entry.collection !== undefined && (
                <div style={{ color: colors.muted, fontSize: 10, fontFamily: monospace }}>{entry.collection}</div>
              )}
              {entry.error !== undefined && (
                <div style={{ color: colors.error, fontSize: 10, marginTop: 2 }}>{entry.error}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <span style={{ display: 'block', color: colors.muted, fontSize: 10, marginTop: 6, fontFamily }}>
        Kept in memory for this session only — this is a diagnostic view, not the audit log.
      </span>
    </section>
  )
}
