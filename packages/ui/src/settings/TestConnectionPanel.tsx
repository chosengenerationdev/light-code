import type { TestConnectionStep } from '@light-code/core/browser'
import { type ReactElement } from 'react'
import { colors, fontFamily, secondaryButtonStyle } from '../theme.js'

export interface TestConnectionPanelProps {
  running: boolean
  result: { ok: boolean; steps: TestConnectionStep[] } | undefined
  onRun: () => void
}

const STEP_LABELS: Record<TestConnectionStep['step'], string> = {
  certificates: 'Load certificates',
  token: 'Acquire credential',
  models: 'List models',
}

function markerFor(status: TestConnectionStep['status']): { glyph: string; color: string } {
  if (status === 'ok') return { glyph: '✓', color: 'var(--vscode-testing-iconPassed, #3fb950)' }
  if (status === 'failed') return { glyph: '✕', color: colors.error }
  return { glyph: '–', color: colors.muted }
}

/**
 * Reports **which step failed**, not a single pass/fail (§10). "The handshake worked but
 * the token endpoint returned 401" and "the CA is not trusted" need completely different
 * fixes, and collapsing them into one red X is what makes these failures opaque.
 */
export function TestConnectionPanel(props: TestConnectionPanelProps): ReactElement {
  return (
    <div style={{ marginBottom: 16, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
      <button type="button" style={secondaryButtonStyle()} onClick={props.onRun} disabled={props.running}>
        {props.running ? 'Testing…' : 'Test Connection'}
      </button>

      {props.result !== undefined && (
        <div style={{ marginTop: 8, fontFamily, fontSize: 12 }}>
          {props.result.steps.map((step) => {
            const marker = markerFor(step.status)
            return (
              <div key={step.step} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                <span style={{ color: marker.color, width: 12, flexShrink: 0 }}>{marker.glyph}</span>
                <div>
                  <div style={{ color: colors.foreground }}>{STEP_LABELS[step.step]}</div>
                  <div style={{ color: step.status === 'failed' ? colors.error : colors.muted, fontSize: 11 }}>
                    {step.detail}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
