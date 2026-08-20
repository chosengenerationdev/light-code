import { type ReactElement } from 'react'
import { colors, fontFamily, labelStyle, secondaryButtonStyle } from '../theme.js'

export interface DispatcherSectionProps {
  enabled: boolean
  /** How many tools are hidden, or would be if it were switched on. */
  hiddenTools: number
  /** Skill summaries are retrieved rather than listed. */
  skills: boolean
  /** How many skills that affects. */
  hiddenSkills: number
  onToggleSkills: (enabled: boolean) => void
  docsIndex?: string | undefined
  onToggle: (enabled: boolean) => void
  onIndexDocs: () => void
  /** Empties the index. Separate from reindexing, which replaces rather than removes. */
  onClearDocsIndex: () => void
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
          // Not "this would change nothing" any more: with the dispatcher on by default, an
          // empty catalogue means the dispatcher tools are not registered at all, and saying
          // so is the difference between "inert" and "costing you three tool schemas".
          <>No MCP or Python tools to hide, so nothing is registered for this and it costs nothing.</>
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

      {/*
        Its own checkbox rather than folded into the one above, because it is a different
        trade. A tool schema is large and the model knows it wants "a tool that lists PRs"; a
        skill summary is one line and is the only thing that tells the model the subject was
        ever written about. So this saves less and risks more, and someone should be able to
        keep tool retrieval while leaving skills listed.
      */}
      <label
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          margin: '0 0 8px',
          cursor: props.enabled ? 'pointer' : 'not-allowed',
          opacity: props.enabled ? 1 : 0.55,
        }}
      >
        <input
          type="checkbox"
          checked={props.skills && props.enabled}
          disabled={!props.enabled}
          onChange={(event) => props.onToggleSkills(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          <span style={{ display: 'block', fontSize: 13 }}>Look up skills the same way</span>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
            Skill summaries stop being listed in every request. A count and an instruction to
            search stay, so the assistant still knows notes exist and looks for one before
            working on something unfamiliar.{' '}
            {props.hiddenSkills === 0
              ? 'No skills recorded yet, so this changes nothing today.'
              : `${String(props.hiddenSkills)} ${props.hiddenSkills === 1 ? 'skill' : 'skills'} affected.`}
            {!props.enabled && ' Needs the setting above, which is what finds them.'}
          </span>
        </span>
      </label>

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
        {/*
          Clearing is not the same as reindexing, which is why both are here. Reindexing
          replaces what a tool or skill *currently* describes; it cannot know about an entry
          whose owner has gone from the corpus entirely, and a stale hit costs findability.
        */}
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={props.indexing || !props.retrievalReady}
          title="Remove every indexed tool and skill document. search_docs falls back to matching names and descriptions until you index again."
          onClick={props.onClearDocsIndex}
        >
          Clear index
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
