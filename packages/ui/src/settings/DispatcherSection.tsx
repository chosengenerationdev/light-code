import { type ReactElement } from 'react'
import { colors, fontFamily, labelStyle, secondaryButtonStyle } from '../theme.js'

export interface DispatcherSectionProps {
  enabled: boolean
  /** How many tools are hidden, or would be if it were switched on. */
  hiddenTools: number
  docsIndex?: string | undefined
  onToggle: (enabled: boolean) => void
  onIndexDocs: () => void
  indexing: boolean
  result?: { indexed?: number; index?: string; error?: string } | undefined
  /** Semantic matching needs both; without them search_docs still works, lexically. */
  retrievalReady: boolean
}

/**
 * Keeping tool schemas out of the prompt (§12).
 *
 * Leads with the number of tools affected rather than an explanation, because that number is
 * the decision: at two hidden tools this is pure downside, and at eighty it is obvious. No
 * paragraph argues the case as well as the count does.
 */
export function DispatcherSection(props: DispatcherSectionProps): ReactElement {
  const worthwhile = props.hiddenTools >= 15

  return (
    <section style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
      <span style={labelStyle()}>Tool documentation index</span>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '6px 0 8px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={props.enabled}
          onChange={(event) => props.onToggle(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          <span style={{ display: 'block', fontSize: 13 }}>Keep tool schemas out of the prompt</span>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
            MCP and Python tools stop being listed in every request. The model finds them with{' '}
            <code style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>search_docs</code> and runs them
            through <code style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>call_tool</code>. You
            still approve everything exactly as before.
          </span>
        </span>
      </label>

      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px' }}>
        {props.hiddenTools === 0 ? (
          <>There are no MCP or Python tools to hide, so this would change nothing.</>
        ) : (
          <>
            {props.enabled ? 'Hiding' : 'Would hide'}{' '}
            <strong style={{ color: colors.foreground }}>{props.hiddenTools}</strong>{' '}
            {props.hiddenTools === 1 ? 'tool' : 'tools'}.{' '}
            {worthwhile ? (
              <>That is enough to be worth it.</>
            ) : (
              // Said plainly rather than hidden, because the tradeoff is real: models call a
              // tool listed in the prompt more reliably than one named inside call_tool.
              <>
                With this few, leaving it off is probably better — models call a listed tool more
                reliably than one named through a dispatcher.
              </>
            )}
          </>
        )}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={props.indexing || !props.retrievalReady}
          title={
            props.retrievalReady
              ? 'Embed the tool and skill documentation so search_docs can match by meaning'
              : 'Needs a search connection and an embedding model. Without them search_docs still works, matching names and descriptions.'
          }
          onClick={props.onIndexDocs}
        >
          {props.indexing ? 'Indexing…' : 'Index documentation'}
        </button>
        {props.docsIndex !== undefined && (
          <span style={{ color: colors.muted, fontSize: 11, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
            {props.docsIndex}
          </span>
        )}
      </div>

      {/*
       * Stated whenever retrieval is unavailable, not only on failure. Someone who enables the
       * dispatcher without a vector store should know their tools are still findable — the
       * alternative reading, that they have just hidden everything irreversibly, is alarming
       * and wrong.
       */}
      {!props.retrievalReady && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '8px 0 0' }}>
          No embedding model configured, so <code>search_docs</code> matches on names and
          descriptions instead of by meaning. Tools remain findable either way.
        </p>
      )}

      {props.result?.error !== undefined && (
        <p style={{ color: colors.error, fontSize: 11, margin: '8px 0 0' }}>{props.result.error}</p>
      )}
      {props.result?.indexed !== undefined && props.result.error === undefined && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '8px 0 0', fontFamily }}>
          Indexed {props.result.indexed} {props.result.indexed === 1 ? 'entry' : 'entries'}
          {props.result.index !== undefined ? ` into ${props.result.index}` : ''}.
        </p>
      )}
    </section>
  )
}
