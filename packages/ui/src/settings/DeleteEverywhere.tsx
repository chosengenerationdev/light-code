import type { DeleteEverywherePlan, HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'

import { colors, monospaceFamily, secondaryButtonStyle } from '../theme.js'

/**
 * "Delete everywhere" for one skill or tool (asked for: "a force delete skill or tool even from repo or s3
 * bucket"). Two presses: the first asks the host what would be removed and shows the literal list - every
 * file on this computer, every bucket object, every repository file (replaced by a deletion marker) - and
 * only the second removes it. Self-contained, like the Usage tab: it talks to the host itself.
 */
export function DeleteEverywhere(props: { transport: Transport; kind: 'skill' | 'tool'; name: string }): ReactElement {
  const [plan, setPlan] = useState<DeleteEverywherePlan | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | undefined>(undefined)

  useEffect(
    () =>
      props.transport.onMessage((raw) => {
        const message = raw as HostToUiMessage
        if (message.type === 'deleteEverywherePlan' && message.plan.kind === props.kind && message.plan.name === props.name) {
          setPlan(message.plan)
          setBusy(false)
        } else if (message.type === 'deleteEverywhereDone' && message.kind === props.kind && message.name === props.name) {
          setResult({ ok: message.ok, message: message.message })
          setPlan(undefined)
          setBusy(false)
        }
      }),
    [props.transport, props.kind, props.name],
  )

  const ask = (): void => {
    setResult(undefined)
    setBusy(true)
    props.transport.post({ type: 'previewDeleteEverywhere', kind: props.kind, name: props.name } satisfies UiToHostMessage)
  }
  const confirm = (): void => {
    if (plan === undefined) return
    setBusy(true)
    props.transport.post({ type: 'deleteEverywhere', plan } satisfies UiToHostMessage)
  }

  const list = (title: string, items: readonly string[]): ReactElement | null =>
    items.length === 0 ? null : (
      <div style={{ marginTop: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 600 }}>{title}</div>
        <ul style={{ margin: '2px 0', paddingLeft: 18, fontFamily: monospaceFamily, fontSize: 11 }}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    )

  return (
    <span style={{ display: 'contents' }}>
      {plan === undefined ? (
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={busy}
          title={busy ? 'Working…' : `Remove this ${props.kind} from this computer, the S3 bucket and the team repository - shows what first`}
          onClick={ask}
        >
          {busy ? 'Checking…' : 'Delete everywhere'}
        </button>
      ) : null}
      {(plan !== undefined || result !== undefined) && (
        <div
          role={result?.ok === false || plan?.error !== undefined ? 'alert' : 'status'}
          style={{ flexBasis: '100%', width: '100%', marginTop: 6, padding: 8, border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 12 }}
        >
          {result !== undefined ? (
            <div style={{ color: result.ok ? undefined : colors.error }}>{result.message}</div>
          ) : plan?.error !== undefined ? (
            <div style={{ color: colors.error }}>{plan.error}</div>
          ) : plan !== undefined ? (
            <>
              <div style={{ fontWeight: 600 }}>
                Delete the {props.kind} &quot;{props.name}&quot; everywhere - for you and the team. This removes:
              </div>
              {list('On this computer', plan.local)}
              {plan.buckets.map((bucket) => list(`In the S3 bucket ${bucket.label}`, bucket.keys))}
              {list(`In the team repository ${plan.repoLabel ?? ''} (replaced by a "deleted" marker; history keeps the old version)`, plan.repo)}
              {plan.notes.length > 0 && (
                <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 11, color: colors.muted }}>
                  {plan.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button type="button" style={{ ...secondaryButtonStyle(), color: colors.error }} disabled={busy} title={busy ? 'Deleting…' : 'Remove everything listed above'} onClick={confirm}>
                  {busy ? 'Deleting…' : 'Delete all of this'}
                </button>
                <button type="button" style={secondaryButtonStyle()} disabled={busy} title={busy ? 'Deleting…' : 'Keep it'} onClick={() => setPlan(undefined)}>
                  Cancel
                </button>
              </div>
            </>
          ) : null}
          {result !== undefined && (
            <button type="button" style={{ ...secondaryButtonStyle(), marginTop: 6 }} title="Hide this message" onClick={() => setResult(undefined)}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </span>
  )
}
