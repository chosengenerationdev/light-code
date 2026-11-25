import { useEffect, useState, type ReactElement } from 'react'

import type { DecisionModelSettings, DecisionTestResult, HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'

import { Select } from '../Select.js'
import { colors, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { disabledWhen } from '../disabledWhen.js'
import { Panel } from './Panel.js'
import { SeatModelPicker } from './SeatModelPicker.js'

/**
 * Settings → Agents → Decision model. Self-contained, talking to the host through the transport itself (the
 * `UsageTab` pattern), so nothing else in Settings changes.
 *
 * Asked for: D3 (vLLM Semantic Router's decision model) set up as an OpenAI-compatible profile, powering Agent team
 * mode, and nothing of it shown until one is set up - so with no profile chosen this is only the picker.
 */
export function DecisionModelSection(props: { transport: Transport }): ReactElement {
  const { transport } = props
  const [settings, setSettings] = useState<DecisionModelSettings | undefined>(undefined)
  const [profiles, setProfiles] = useState<{ id: string; label: string }[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [results, setResults] = useState<DecisionTestResult[] | undefined>(undefined)
  const [endpoint, setEndpoint] = useState('')
  useEffect(() => setEndpoint(settings?.endpoint ?? ''), [settings?.endpoint])

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'decisionModel') {
        setSettings(message.settings)
        setProfiles(message.profiles)
        setError(message.error)
      } else if (message.type === 'decisionModelTest') {
        setResults(message.results)
        setTesting(false)
      }
    })
    transport.post({ type: 'requestDecisionModel' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])

  const save = (next: DecisionModelSettings): void => {
    setSettings(next)
    transport.post({ type: 'saveDecisionModel', settings: next } satisfies UiToHostMessage)
  }

  const current = settings ?? {}
  const chosen = current.profileId !== undefined && profiles.some((profile) => profile.id === current.profileId)
  const threshold = (value: number | undefined, fallback: number, apply: (v: number) => void): ReactElement => (
    <input
      type="number"
      min={0.5}
      max={0.99}
      step={0.05}
      value={value ?? fallback}
      onChange={(event) => {
        const parsed = Number.parseFloat(event.target.value)
        if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 0.99) apply(parsed)
      }}
      style={{ ...textFieldStyle(), width: 70 }}
    />
  )

  return (
    <div style={{ padding: '0 12px 12px' }}>
      <Panel id="agents.decision" title="Decision model" summary={chosen ? profiles.find((p) => p.id === current.profileId)?.label ?? '' : 'Not set up'}>
        <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 8px' }}>
          A model that answers narrow questions with probabilities - such as D3 from vLLM Semantic Router - set up under
          Providers as an OpenAI-compatible profile. With one chosen, Agent team mode sends each message to the
          specialist it picks, and strategy loops are judged by it. Without one, everything works as before.
        </p>
        <label style={labelStyle()}>Profile</label>
        <Select
          value={current.profileId ?? ''}
          options={[{ value: '', label: 'None' }, ...profiles.map((profile) => ({ value: profile.id, label: profile.label }))]}
          onChange={(value) => save(value === '' ? {} : { ...current, profileId: value, model: undefined })}
          ariaLabel="Decision model profile"
        />
        {chosen && <SeatModelPicker transport={transport} profileId={current.profileId} value={current.model} onChange={(model) => save({ ...current, model })} />}
        {profiles.length === 0 && (
          <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0' }}>Add the decision model under Providers (OpenAI-compatible) first.</p>
        )}
        {error !== undefined && <p style={{ color: colors.error, fontSize: 11, margin: '6px 0 0' }}>{error}</p>}

        {chosen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <div>
              <label style={labelStyle()} htmlFor="decision-endpoint">
                Endpoint
              </label>
              <input
                id="decision-endpoint"
                value={endpoint}
                placeholder="Automatic: /systemone, then chat completions"
                onChange={(event) => setEndpoint(event.target.value)}
                onBlur={() => {
                  const next = endpoint.trim()
                  if (next !== (current.endpoint ?? '')) save(next === '' ? { ...current, endpoint: undefined } : { ...current, endpoint: next })
                }}
                style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
              />
              <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
                Added to the provider's base URL. D3 answers on <code style={{ fontFamily: monospaceFamily }}>/systemone</code> (its own decision API,
                not chat completions); if your gateway puts it elsewhere, type that path, e.g.{' '}
                <code style={{ fontFamily: monospaceFamily }}>/d3/v1/systemone</code>. Type <code style={{ fontFamily: monospaceFamily }}>chat</code> for a
                decision model that only answers chat completions. Blank tries /systemone first, then chat completions.
              </span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={current.routing !== false} onChange={(event) => save({ ...current, routing: event.target.checked })} />
              In Agent team mode, send each message to the specialist it picks, when at least
              {threshold(current.routeThreshold, 0.75, (v) => save({ ...current, routeThreshold: v }))} sure
            </label>
            <span style={{ color: colors.muted, fontSize: 11, marginTop: -6 }}>
              Not with a strategy in use (the strategy says who acts) or when you address someone with #. The main assistant
              still consults the specialist with the usual approvals; a note above the message box shows the choice.
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={current.judgeLoops !== false} onChange={(event) => save({ ...current, judgeLoops: event.target.checked })} />
              Decide strategy loop conditions, when at least
              {threshold(current.loopThreshold, 0.8, (v) => save({ ...current, loopThreshold: v }))} sure either way
            </label>
            <span style={{ color: colors.muted, fontSize: 11, marginTop: -6 }}>
              For back-and-forth connectors with an "until" condition. In between, the judging specialist&rsquo;s own words decide, as before.
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={current.firstPass !== false} onChange={(event) => save({ ...current, firstPass: event.target.checked })} />
              Anti Hallucinator first pass: let a step wait for the next review when at least
              {threshold(current.firstPassThreshold, 0.85, (v) => save({ ...current, firstPassThreshold: v }))} sure it is grounded
            </label>
            <span style={{ color: colors.muted, fontSize: 11, marginTop: -6 }}>
              With the Anti Hallucinator on (Settings → Project). A step it is sure of is still given to the Anti Hallucinator and
              reviewed with the next one; anything else is reviewed straight away, as before. Fewer full reviews, never none.
            </span>
            {(
              [
                ['scoreHandOvers', 'Score strategy hand-overs against their contract, and ask once more when one falls short'],
                ['suggestRoles', 'In Agent team mode, say when another specialist fits a consultation better'],
                ['newTopics', 'Tell when a changed plan is new work, so a strategy’s loops start again'],
                ['triageAlerts', 'Fire Code monitoring: announce alerts by whether they need you now (never quieter for red)'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={current[key] !== false} onChange={(event) => save({ ...current, [key]: event.target.checked })} />
                {label}
              </label>
            ))}
            <span style={{ color: colors.muted, fontSize: 11, marginTop: -6 }}>
              Picking the skill and tool for each request is switched on per chat, with “Skills & tools” beside the mode picker; a new chat started from that chat keeps it.
              A strategy step can also be a decision step: open it in the Strategy window and tick “The decision model picks the next step”.
            </span>
            <div>
              <button
                type="button"
                style={testing ? secondaryButtonStyle() : primaryButtonStyle(false)}
                {...disabledWhen([testing, 'Already asking the decision model.'], { enabledTitle: 'Ask two sample questions and show what came back.' })}
                onClick={() => {
                  setTesting(true)
                  setResults(undefined)
                  transport.post({ type: 'testDecisionModel' } satisfies UiToHostMessage)
                }}
              >
                {testing ? 'Asking…' : 'Test decision model'}
              </button>
            </div>
            {results !== undefined && (
              <div data-testid="decision-test" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {results.map((result, index) => (
                  <div key={index} style={{ border: `1px solid ${colors.border}`, borderRadius: 6, padding: 8, fontSize: 12 }}>
                    <div style={{ fontWeight: 600 }}>{result.question}</div>
                    {result.ok ? (
                      <div style={{ color: colors.accent }}>
                        Read from {result.source === 'systemone' ? "D3's decision API" : result.source === 'logprobs' ? 'token probabilities on a chat completion' : 'JSON in a chat completion'} in {result.ms} ms:{' '}
                        {Object.entries(result.probabilities ?? {})
                          .sort((a, b) => b[1] - a[1])
                          .map(([id, p]) => `${id} ${p.toFixed(2)}`)
                          .join(', ')}
                        {result.expected.length > 0 ? ` (expected ${result.expected})` : ''}
                      </div>
                    ) : (
                      <div style={{ color: colors.error }}>{result.error}</div>
                    )}
                    {result.raw.length > 0 && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ cursor: 'pointer', color: colors.muted }}>What came back</summary>
                        <pre style={{ fontFamily: monospaceFamily, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '4px 0 0' }}>{result.raw}</pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  )
}
