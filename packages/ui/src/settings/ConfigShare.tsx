import { useState, type ReactElement } from 'react'

import { colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'

/**
 * Choosing what a config export carries, and seeing what an import will bring.
 *
 * Both directions are one component because they are one question — which of these sections —
 * asked of two different configs. Two components would be two renderings of the same list, and
 * the handover notes are mostly about what happens when one fact is built in two places.
 *
 * ## Why the counts matter more than the labels
 *
 * "Providers" is a category; "3 providers" is something somebody can decide about. The detail line
 * is read from the actual config host-side rather than described here for exactly that reason, and
 * it is why a section with nothing in it is shown greyed rather than hidden: absent and
 * unticked look identical otherwise, and only one of them means "you have none of these".
 *
 * ## The credentials line
 *
 * Shown on both sides, from the same data. On the way out it answers "what will my colleague have
 * to do"; on the way in, "what do I have to do before this works". Names only — an export has
 * never contained a secret value, and this says which pointers will land with nothing behind them.
 */

export interface ShareSectionView {
  id: string
  label: string
  description: string
  present: boolean
  detail: string
  machineSpecific?: boolean
  offByDefault?: boolean
  /** What this section deliberately leaves out. Shown, because a silent omission is a surprise. */
  stripNote?: string
  secretRefs: string[]
}

export interface ConfigShareProps {
  direction: 'export' | 'import'
  sections: ShareSectionView[]
  /** Which arrive ticked. Held here afterwards, because the user is editing it. */
  initialSelected: string[]
  /** The file a preview opened; passed straight back so nobody chooses it twice. */
  path?: string | undefined
  error?: string | undefined
  onConfirm: (selected: string[]) => void
  onCancel: () => void
}

export function ConfigShare(props: ConfigShareProps): ReactElement {
  const [selected, setSelected] = useState<string[]>(props.initialSelected)

  const toggle = (id: string): void => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    )
  }

  const chosen = props.sections.filter((section) => selected.includes(section.id) && section.present)
  const credentials = [...new Set(chosen.flatMap((section) => section.secretRefs))]
  const exporting = props.direction === 'export'

  if (props.error !== undefined) {
    return (
      <div style={panelStyle()}>
        <div style={{ color: colors.error, fontSize: 12 }}>{props.error}</div>
        <div style={{ marginTop: 8 }}>
          <button type="button" style={secondaryButtonStyle()} onClick={props.onCancel}>
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={panelStyle()}>
      <label style={labelStyle()}>{exporting ? 'Export settings' : 'Import settings'}</label>
      <div style={{ color: colors.muted, fontSize: 11, marginBottom: 8 }}>
        {exporting
          ? 'Choose what to send. Passwords and API keys are never included — whoever imports this enters their own.'
          : 'This is what the file contains. Nothing has changed yet.'}
      </div>
      {props.path !== undefined && (
        <div style={{ color: colors.muted, fontSize: 10, fontFamily: monospaceish, marginBottom: 8 }}>
          {props.path}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {props.sections.map((section) => (
          <label
            key={section.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 12,
              // Shown rather than hidden, so "you have none of these" is distinguishable from
              // "this was not offered".
              opacity: section.present ? 1 : 0.45,
            }}
          >
            <input
              type="checkbox"
              checked={selected.includes(section.id)}
              disabled={!section.present}
              onChange={() => toggle(section.id)}
              style={{ marginTop: 2 }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{section.label}</span>
              <span style={{ color: colors.muted }}> — {section.detail}</span>
              <div style={{ color: colors.muted, fontSize: 11 }}>{section.description}</div>
              {section.stripNote !== undefined && section.present && (
                <div style={{ color: colors.muted, fontSize: 11 }}>
                  {/*
                    Said out loud on both sides. On the way out it explains why a colleague still
                    has something to set; on the way in it explains why importing did not change
                    a field they can see. An omission nobody mentions is read as a bug.
                  */}
                  {section.stripNote}
                </div>
              )}
              {section.machineSpecific === true && section.present && (
                <div style={{ color: colors.muted, fontSize: 11 }}>
                  {/*
                    Said beside the box rather than withheld. A team on a standard build genuinely
                    does want to share an interpreter path; the failure mode worth warning about is
                    a setting that looks present on the other machine and points at nothing.
                  */}
                  Contains paths from this machine — check them after importing.
                </div>
              )}
            </span>
          </label>
        ))}
      </div>

      {credentials.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: colors.muted }}>
          <div style={{ fontWeight: 600, color: colors.foreground }}>
            {exporting ? 'They will need to enter:' : 'You will need to enter:'}
          </div>
          <ul style={{ margin: '2px 0 0 16px', padding: 0 }}>
            {credentials.map((ref) => (
              <li key={ref}>{ref}</li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <button
          type="button"
          style={primaryButtonStyle(chosen.length === 0)}
          disabled={chosen.length === 0}
          onClick={() => props.onConfirm(selected)}
        >
          {exporting ? `Export ${String(chosen.length)} section(s)` : `Import ${String(chosen.length)} section(s)`}
        </button>
        <button type="button" style={secondaryButtonStyle()} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {!exporting && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 6 }}>
          {/*
            Stated because it is the one thing somebody can get wrong here. A section is taken or
            kept whole — there is no honest way to merge two lists of providers — so importing
            Providers replaces the ones on this machine rather than adding to them.
          */}
          Each section you take replaces what is here, rather than merging with it.
        </div>
      )}
    </div>
  )
}

const monospaceish = 'var(--vscode-editor-font-family, monospace)'

function panelStyle(): React.CSSProperties {
  return {
    marginTop: 10,
    padding: 10,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    fontFamily,
  }
}
