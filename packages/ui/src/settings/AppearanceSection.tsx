import { useState, type ReactElement } from 'react'
import { ACCENT_PRESETS, DEFAULT_ACCENT, contrastFor, isValidAccent } from '../styles.js'
import { CheckIcon } from '../icons.js'
import { colors, fontFamily, labelStyle, textFieldStyle } from '../theme.js'

export interface AppearanceSectionProps {
  accentColor: string
  onChange: (value: string) => void
}

/**
 * The accent picker.
 *
 * Swatches rather than a colour wheel, because the eight offered are already contrast-checked
 * against both light and dark editor themes. The free-text hex field is there for the person
 * who wants their company's colour and will otherwise go and hand-edit the config file — the
 * same reasoning as §9's "the dropdown is never a hard dependency".
 *
 * Changes apply live as you type a valid colour, so the choice is judged against the real UI
 * rather than a swatch. Only a valid value is sent onward; a half-typed `#A8` never reaches
 * config.
 */
export function AppearanceSection(props: AppearanceSectionProps): ReactElement {
  const [custom, setCustom] = useState(props.accentColor)

  const commit = (value: string): void => {
    setCustom(value)
    if (isValidAccent(value)) props.onChange(value)
  }

  const active = props.accentColor.toLowerCase()

  return (
    <section style={{ marginBottom: 20 }}>
      <span style={labelStyle()}>Accent colour</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {ACCENT_PRESETS.map((preset) => {
          const selected = preset.value.toLowerCase() === active
          return (
            <button
              key={preset.id}
              type="button"
              className="lc-swatch"
              // The name is the tooltip, not a caption — eight labelled swatches is a list,
              // eight circles is a palette.
              title={preset.label}
              aria-label={preset.label}
              aria-pressed={selected}
              onClick={() => commit(preset.value)}
              style={{
                width: 26,
                height: 26,
                borderRadius: '50%',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `linear-gradient(135deg, ${preset.value}, ${preset.value})`,
                color: contrastFor(preset.value),
              }}
            >
              {selected && <CheckIcon size={13} />}
            </button>
          )
        })}
      </div>

      <label style={{ ...labelStyle(), marginBottom: 4 }} htmlFor="lc-accent-hex">
        Or a custom hex colour
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          id="lc-accent-hex"
          type="text"
          value={custom}
          spellCheck={false}
          placeholder={DEFAULT_ACCENT}
          onChange={(event) => commit(event.target.value)}
          style={{ ...textFieldStyle(), width: 130, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
        />
        <span
          aria-hidden="true"
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            flexShrink: 0,
            background: isValidAccent(custom) ? custom : 'transparent',
            border: `1px solid ${colors.border}`,
          }}
        />
        {!isValidAccent(custom) && (
          <span style={{ color: colors.error, fontSize: 11, fontFamily }}>Needs a hex colour, e.g. #A855F7</span>
        )}
      </div>
    </section>
  )
}
