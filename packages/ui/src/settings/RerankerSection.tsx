import { useEffect, useState, type ReactElement } from 'react'

import type { HostToUiMessage, RerankerSettings, RerankerTestResult, Transport, UiToHostMessage } from '@light-code/core/browser'

import { Select } from '../Select.js'
import { colors, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { disabledWhen } from '../disabledWhen.js'
import { Panel } from './Panel.js'
import { SeatModelPicker } from './SeatModelPicker.js'

/**
 * Settings → Search → Reranker. Self-contained over the transport, like the Decision model panel.
 *
 * Asked for: a BGE reranker, served behind an OpenAI-compatible provider, used to find skills and tools, team skills
 * and code - and to work with the decision model when both are set up. With no profile chosen this is only the picker.
 */
export function RerankerSection(props: { transport: Transport }): ReactElement {
  const { transport } = props
  const [settings, setSettings] = useState<RerankerSettings | undefined>(undefined)
  const [profiles, setProfiles] = useState<{ id: string; label: string }[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<RerankerTestResult | undefined>(undefined)
  const [endpoint, setEndpoint] = useState('')
  useEffect(() => setEndpoint(settings?.endpoint ?? ''), [settings?.endpoint])

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'reranker') {
        setSettings(message.settings)
        setProfiles(message.profiles)
        setError(message.error)
      } else if (message.type === 'rerankerTest') {
        setResult(message.result)
        setTesting(false)
      }
    })
    transport.post({ type: 'requestReranker' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])

  const save = (next: RerankerSettings): void => {
    setSettings(next)
    transport.post({ type: 'saveReranker', settings: next } satisfies UiToHostMessage)
  }

  const current = settings ?? {}
  const chosen = current.profileId !== undefined && profiles.some((profile) => profile.id === current.profileId)
  const number = (id: string, value: number, min: number, max: number, step: number, apply: (v: number) => void): ReactElement => (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => {
        const parsed = Number.parseFloat(event.target.value)
        if (Number.isFinite(parsed) && parsed >= min && parsed <= max) apply(parsed)
      }}
      style={{ ...textFieldStyle(), width: 70 }}
    />
  )

  return (
    <div style={{ padding: '0 12px 12px' }}>
      <Panel id="search.reranker" title="Reranker" summary={chosen ? (profiles.find((p) => p.id === current.profileId)?.label ?? '') : 'Not set up'}>
        <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 8px' }}>
          A reranking model - such as BAAI&rsquo;s bge-reranker - set up under Providers as an OpenAI-compatible profile. It reads each thing a search
          found together with the question and puts the most relevant first, setting aside what does not fit. Without one, searches work as before.
        </p>
        <label style={labelStyle()}>Profile</label>
        <Select
          value={current.profileId ?? ''}
          options={[{ value: '', label: 'None' }, ...profiles.map((profile) => ({ value: profile.id, label: profile.label }))]}
          onChange={(value) => save(value === '' ? {} : { ...current, profileId: value, model: undefined })}
          ariaLabel="Reranker profile"
        />
        {chosen && <SeatModelPicker transport={transport} profileId={current.profileId} value={current.model} onChange={(model) => save({ ...current, model })} />}
        {profiles.length === 0 && (
          <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0' }}>
            Add the reranker under Providers first: OpenAI-compatible, its server&rsquo;s address as the base URL (e.g. ending in /v1 or not - both work), and its
            model name (e.g. bge-reranker-v2-m3).
          </p>
        )}
        {error !== undefined && <p style={{ color: colors.error, fontSize: 11, margin: '6px 0 0' }}>{error}</p>}

        {chosen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <div>
              <label style={labelStyle()} htmlFor="reranker-endpoint">
                Endpoint
              </label>
              <input
                id="reranker-endpoint"
                value={endpoint}
                placeholder="Automatic: /v1/rerank, /rerank, then /v1/score"
                onChange={(event) => setEndpoint(event.target.value)}
                onBlur={() => {
                  const next = endpoint.trim()
                  if (next !== (current.endpoint ?? '')) save(next === '' ? { ...current, endpoint: undefined } : { ...current, endpoint: next })
                }}
                style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
              />
              <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
                Added to the provider&rsquo;s base URL. vLLM, Infinity and TEI answer on <code style={{ fontFamily: monospaceFamily }}>/rerank</code> or{' '}
                <code style={{ fontFamily: monospaceFamily }}>/v1/rerank</code>; blank tries those and vLLM&rsquo;s <code style={{ fontFamily: monospaceFamily }}>/v1/score</code>,
                and remembers the one that answered.
              </span>
            </div>
            <span style={{ fontWeight: 600, fontSize: 12 }}>Use it for</span>
            {(
              [
                ['docs', 'Finding tools and skills (search_docs) - with no vector index, it ranks every tool and skill itself'],
                ['teamSkills', 'Team skills search (search_team_skills)'],
                ['codebase', 'Codebase search (search_codebase)'],
                ['picks', 'Skill and tool picks with the decision model: it narrows to the best ten, and the decision model chooses among them'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={current[key] !== false} onChange={(event) => save({ ...current, [key]: event.target.checked })} />
                {label}
              </label>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }} htmlFor="reranker-min">
              Set aside results scoring under
              {number('reranker-min', current.minScore ?? 0.05, 0, 0.95, 0.05, (v) => save({ ...current, minScore: v }))}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }} htmlFor="reranker-candidates">
              Give it the
              {number('reranker-candidates', current.candidates ?? 30, 5, 200, 5, (v) => save({ ...current, candidates: Math.round(v) }))}
              nearest results to reorder
            </label>
            <span style={{ color: colors.muted, fontSize: 11, marginTop: -6 }}>
              If it is slow or does not answer (5 seconds), a search keeps its own order and says so - nothing stops working.
            </span>
            <div>
              <button
                type="button"
                style={testing ? secondaryButtonStyle() : primaryButtonStyle(false)}
                {...disabledWhen([testing, 'Already asking the reranker.'], { enabledTitle: 'Rank four sample texts against one question and show the order.' })}
                onClick={() => {
                  setTesting(true)
                  setResult(undefined)
                  transport.post({ type: 'testReranker' } satisfies UiToHostMessage)
                }}
              >
                {testing ? 'Asking…' : 'Test reranker'}
              </button>
            </div>
            {result !== undefined && (
              <div data-testid="reranker-test" style={{ border: `1px solid ${colors.border}`, borderRadius: 6, padding: 8, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontWeight: 600 }}>{result.query}</div>
                {result.ok ? (
                  <>
                    <div style={{ color: result.order[0]?.expectedFirst === true ? colors.accent : colors.error }}>
                      {result.order[0]?.expectedFirst === true ? 'Works' : 'Answered, but did not put the matching text first'} - {result.ms} ms
                      {result.endpoint !== undefined ? `, at ${result.endpoint}` : ''}
                    </div>
                    <ol style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                      {result.order.map((entry, index) => (
                        <li key={index}>
                          <code style={{ fontFamily: monospaceFamily }}>{entry.score.toFixed(3)}</code> {entry.text}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <div style={{ color: colors.error }}>{result.error}</div>
                )}
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  )
}
