import { useEffect, useState, type ReactElement } from 'react'

import { Select } from '../Select.js'
import { colors, fontFamily, labelStyle, primaryButtonStyle } from '../theme.js'
import { ScopeBadge } from './ScopeBadge.js'

export interface ExpertProfilePanelProps {
  enabled: boolean
  /** Which profile answers, if one has been chosen. */
  profileId: string | undefined
  profiles: { id: string; label: string }[]
  onSave: (enabled: boolean, profileId: string) => void
}

/**
 * The Expert tab where the expert is a **configured provider profile**.
 *
 * ## What is missing, and why that is the feature
 *
 * No budget, no per-consultation cost, no savings panel, no keep-alive, no cost measurement, no
 * junior assessment. Every one of those exists because the Claude CLI charges per call and prices
 * a cold start an order of magnitude above a resumed one, so the money was worth managing inside
 * the product. A profile on a gateway has none of that shape.
 *
 * Rendering them anyway, greyed or zeroed, would be worse than leaving them out: a spend cap over
 * something nothing meters is a control that looks like protection and is not, and a savings
 * figure derived from a price nobody measured is a number on a screen that will be believed.
 * CLAUDE.md's rule about the savings floor is the same rule — report what is known, and where
 * nothing is known say nothing rather than zero.
 *
 * ## Why a picker and not a second set of connection fields
 *
 * The expert is a profile the user has already set up, with its own base URL, auth and TLS. A
 * second copy of those here would be a second place to rotate a credential, and the one nobody
 * remembers is the one that breaks.
 */
export function ExpertProfilePanel(props: ExpertProfilePanelProps): ReactElement {
  const [enabled, setEnabled] = useState(props.enabled)
  const [profileId, setProfileId] = useState(props.profileId ?? '')
  const [saved, setSaved] = useState(false)

  // Resynced when the host answers, for the reason the very first settings screen taught: the
  // panel can mount before the reply arrives, and whichever won that race decided whether the
  // fields showed real data or stayed empty for ever.
  useEffect(() => {
    setEnabled(props.enabled)
    setProfileId(props.profileId ?? '')
    setSaved(false)
  }, [props.enabled, props.profileId])

  const chosen = props.profiles.find((profile) => profile.id === profileId)

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, color: colors.foreground }}>Expert</h3>
        <ScopeBadge scope="user" />
      </div>

      <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 12px', lineHeight: 1.5 }}>
        Lets your everyday model consult a stronger one on hard problems — planning a change across
        several files, diagnosing a bug it has already failed to fix, or weighing two designs. It
        decides when a question is worth asking, and the consultation appears in the transcript.
      </p>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          marginBottom: 12,
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span style={{ fontSize: 12, color: colors.foreground }}>
          Let the assistant consult an expert
        </span>
      </label>

      {enabled && (
        <div style={{ marginBottom: 12 }}>
          <span style={labelStyle()}>Which model answers</span>
          <Select
            value={profileId}
            onChange={setProfileId}
            options={[
              { value: '', label: 'None chosen — the expert is unavailable' },
              ...props.profiles.map((profile) => ({ value: profile.id, label: profile.label })),
            ]}
          />
          <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0', lineHeight: 1.5 }}>
            {props.profiles.length === 0 ? (
              <>Add a provider in the Providers tab first — the expert is one of those.</>
            ) : chosen === undefined ? (
              <>
                Until one is chosen the expert tool is not offered at all, rather than quietly
                falling back to the model you are chatting with. The point of an expert is a second
                opinion, and asking the model that is already stuck would give you advice with
                nothing to distrust about it.
              </>
            ) : (
              <>
                Pick a profile stronger than the one you chat with, or there is nothing to gain. It
                is asked in a single request with no tools: it cannot read your workspace, so the
                assistant has to put the relevant code in the question, and it does not remember
                earlier consultations.
              </>
            )}
          </p>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          style={primaryButtonStyle(false)}
          onClick={() => {
            props.onSave(enabled, profileId)
            setSaved(true)
          }}
        >
          Save
        </button>
        {saved && <span style={{ fontSize: 11, color: colors.muted }}>Saved.</span>}
      </div>
    </div>
  )
}
