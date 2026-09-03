import { useEffect, useState, type ReactElement } from 'react'
import {
  ACCENT_PRESETS,
  contrastFor,
  DEFAULT_ACCENT,
  DEFAULT_EXPERT,
  EXPERT_PRESETS,
  isValidAccent,
  type AccentPreset,
} from '../styles.js'
import { CheckIcon, ExpertIcon } from '../icons.js'
import { colors, fontFamily, labelStyle, textFieldStyle } from '../theme.js'

export interface AppearanceSectionProps {
  accentColor: string
  onChangeAccent: (value: string) => void
  expertColor: string
  onChangeExpert: (value: string) => void
  /**
   * Light or dark, where the host has no theme of its own.
   *
   * Absent inside VS Code, where the editor's theme is the answer and a second control would
   * fight it. Present in the browser, because `prefers-color-scheme` follows the *browser's*
   * appearance setting rather than the operating system's — a corporate Edge pinned to light
   * shows a light UI on a dark Windows, with no way to change it and no clue why.
   */
  theme?: 'system' | 'light' | 'dark'
  onChangeTheme?: (theme: 'system' | 'light' | 'dark') => void
}

interface ColourPickerProps {
  label: string
  description: string
  value: string
  presets: readonly AccentPreset[]
  fallback: string
  inputId: string
  onChange: (value: string) => void
}

/**
 * Swatches plus a hex field.
 *
 * Swatches rather than a colour wheel, because the ones offered are already contrast-checked
 * against light and dark editor themes. The free-text field is for the person who wants their
 * company's exact colour and will otherwise go and hand-edit the config file — the same
 * reasoning as §9's "the dropdown is never a hard dependency".
 *
 * Changes apply live as you type a valid colour, so the choice is judged against the real UI
 * rather than a swatch. Only a valid value is sent onward; a half-typed `#A8` never reaches
 * config.
 */
function ColourPicker(props: ColourPickerProps): ReactElement {
  const [custom, setCustom] = useState(props.value)

  // Resyncs when config answers, or when the other picker's save round-trips a fresh
  // settings message. Without this the field keeps whatever was typed at mount.
  useEffect(() => setCustom(props.value), [props.value])

  const commit = (value: string): void => {
    setCustom(value)
    if (isValidAccent(value)) props.onChange(value)
  }

  const active = props.value.toLowerCase()

  return (
    <div style={{ marginBottom: 22 }}>
      <span style={labelStyle()}>{props.label}</span>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>{props.description}</p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {props.presets.map((preset) => {
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
                background: preset.value,
                color: contrastFor(preset.value),
              }}
            >
              {selected && <CheckIcon size={13} />}
            </button>
          )
        })}
      </div>

      <label style={{ ...labelStyle(), marginBottom: 4 }} htmlFor={props.inputId}>
        Or a custom hex colour
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          id={props.inputId}
          type="text"
          value={custom}
          spellCheck={false}
          placeholder={props.fallback}
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
          <span style={{ color: colors.error, fontSize: 11, fontFamily }}>Needs a hex colour, e.g. {props.fallback}</span>
        )}
      </div>
    </div>
  )
}

export function AppearanceSection(props: AppearanceSectionProps): ReactElement {
  const clash = props.accentColor.toLowerCase() === props.expertColor.toLowerCase()

  return (
    <section>
      {props.onChangeTheme !== undefined && (
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle()}>Theme</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            {(['system', 'light', 'dark'] as const).map((option) => {
              const selected = (props.theme ?? 'system') === option
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => props.onChangeTheme?.(option)}
                  style={{
                    ...textFieldStyle(),
                    width: 'auto',
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                    ...(selected
                      ? { borderColor: colors.accent, color: colors.accent, fontWeight: 600 }
                      : {}),
                  }}
                >
                  {option}
                </button>
              )
            })}
          </div>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
            <strong>System</strong> follows your browser&rsquo;s appearance setting — which is the
            browser&rsquo;s own, not Windows&rsquo;. If your browser is pinned to light by policy,
            choose Dark here instead.
          </span>
        </div>
      )}
      <ColourPicker
        label="Accent colour"
        description="Buttons, your messages, selections and focus rings."
        value={props.accentColor}
        presets={ACCENT_PRESETS}
        fallback={DEFAULT_ACCENT}
        inputId="lc-accent-hex"
        onChange={props.onChangeAccent}
      />

      <ColourPicker
        label="Expert colour"
        description="Marks answers that came from Claude rather than from your own model. Kept separate from the accent so the two are told apart at a glance."
        value={props.expertColor}
        presets={EXPERT_PRESETS}
        fallback={DEFAULT_EXPERT}
        inputId="lc-expert-hex"
        onChange={props.onChangeExpert}
      />

      {/*
       * Warned rather than prevented. Two identical colours defeat the point of having two,
       * but it is a legitimate thing to want — and the expert mark icon still distinguishes
       * them — so this states the consequence and leaves the choice alone.
       */}
      {clash && (
        <p style={{ color: colors.error, fontSize: 11, margin: '0 0 14px' }}>
          These are the same colour, so expert answers will not stand out. Only the expert mark
          will tell them apart.
        </p>
      )}

      <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>
        <span style={labelStyle()}>Preview</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <span
              style={{
                padding: '7px 12px',
                borderRadius: '14px 14px 4px 14px',
                background: `linear-gradient(135deg, ${props.accentColor}, ${props.accentColor})`,
                color: contrastFor(props.accentColor),
                fontSize: 12,
                fontFamily,
              }}
            >
              Your message
            </span>
          </div>
          <div style={{ display: 'flex' }}>
            <span
              style={{
                padding: '7px 12px',
                borderRadius: '14px 14px 14px 4px',
                background: colors.assistantBubble,
                color: colors.foreground,
                fontSize: 12,
                fontFamily,
              }}
            >
              The assistant&apos;s reply
            </span>
          </div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              alignSelf: 'flex-start',
              padding: '6px 10px',
              borderRadius: 10,
              border: `1px solid ${props.expertColor}`,
              background: colors.expertSoft,
              color: props.expertColor,
              fontSize: 12,
              fontFamily,
            }}
          >
            <ExpertIcon size={12} />
            Answered by the expert
          </div>
        </div>
      </div>
    </section>
  )
}
