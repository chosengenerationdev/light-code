import { useEffect, useState, type ReactElement } from 'react'
import { ACCENT_PRESETS, DEFAULT_ACCENT, DEFAULT_EXPERT, EXPERT_PRESETS, contrastFor, defaultAgentColor, isValidAccent, type AccentPreset } from '../styles.js'
import { CheckIcon, ExpertIcon } from '../icons.js'
import { colors, fontFamily, labelStyle, textFieldStyle } from '../theme.js'

export interface AppearanceSectionProps {
  accentColor: string
  onChangeAccent: (value: string) => void
  expertColor: string
  /**
   * A colour per specialist, and the roles to offer one for.
   *
   * The roles come from the host rather than being listed here: they are defined in core, and a
   * second list in the appearance panel would be one more place to remember when a role is added
   * — with the symptom being a specialist nobody can recolour.
   */
  agentRoles: { role: string; name: string }[]
  agentColors: Record<string, string>
  onChangeAgentColor: (role: string, hex: string) => void
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
          style={{
            ...textFieldStyle(),
            width: 130,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
          }}
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
          <span style={{ color: colors.error, fontSize: 11, fontFamily }}>
            Needs a hex colour, e.g. {props.fallback}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * A group heading.
 *
 * Reported as "all of them look like the same text": every control carried a `labelStyle()` label
 * and nothing above them did, so a field label and the name of a whole section were typographically
 * identical — eight settings in one undifferentiated column. A heading has to look unlike the
 * things it heads or it is not a heading, so this is smaller, spaced, and separated by a rule.
 */
function GroupHeading(props: { children: string; first?: boolean }): ReactElement {
  return (
    <h4
      style={{
        margin: props.first === true ? '0 0 8px' : '20px 0 8px',
        paddingTop: props.first === true ? 0 : 14,
        borderTop: props.first === true ? 'none' : `1px solid ${colors.border}`,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: colors.muted,
      }}
    >
      {props.children}
    </h4>
  )
}

export function AppearanceSection(props: AppearanceSectionProps): ReactElement {
  const clash = props.accentColor.toLowerCase() === props.expertColor.toLowerCase()

  return (
    <section>
      {props.onChangeTheme !== undefined && <GroupHeading first>Theme</GroupHeading>}
      {props.onChangeTheme !== undefined && (
        <div style={{ marginBottom: 16 }}>
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
      <GroupHeading first={props.onChangeTheme === undefined}>Colours</GroupHeading>

      <ColourPicker
        label="Accent colour"
        description="Buttons, your messages, selections and focus rings."
        value={props.accentColor}
        presets={ACCENT_PRESETS}
        fallback={DEFAULT_ACCENT}
        inputId="lc-accent-hex"
        onChange={props.onChangeAccent}
      />

      {/*
        The seat, not the answerer.

        This description used to say "answers that came from Claude", which was true when Claude
        was the only thing that could hold the seat. It can now be a configured provider, and
        Claude has a colour of its own below — so a description naming Claude here would point at
        the wrong control.
      */}
      <ColourPicker
        label="Expert colour"
        description="Marks answers from whatever holds the expert seat. Kept separate from the accent so the two are told apart at a glance."
        value={props.expertColor}
        presets={EXPERT_PRESETS}
        fallback={DEFAULT_EXPERT}
        inputId="lc-expert-hex"
        onChange={props.onChangeExpert}
      />

      {/*
        Claude's own, because it is a different answerer rather than a role.

        Without it there was nowhere to set this at all: the list below is built from team roles
        and Claude is not one, so the colour existed and could not be changed — a setting that is
        present and unreachable, which is the same as absent.
      */}
      <ColourPicker
        label="Claude colour"
        description="Marks answers from the Claude command line specifically, so they are told apart from an expert seat held by a configured model."
        value={props.agentColors['claude'] ?? defaultAgentColor('claude')}
        presets={EXPERT_PRESETS}
        fallback={defaultAgentColor('claude')}
        inputId="lc-agent-claude-hex"
        onChange={(hex) => props.onChangeAgentColor('claude', hex)}
      />

      {/*
        One per specialist, for the same reason the expert has one.

        The expert's colour marks *authorship* — these words came from somewhere other than the
        model you are talking to. With a team, "somewhere else" stops being one place: a review and
        a test plan arriving in the same colour are two voices presented as one, and which
        specialist said it is exactly what the reader needs to know.
      */}
      {props.agentRoles.filter((role) => role.role !== 'expert').length > 0 && (
        <GroupHeading>Specialists</GroupHeading>
      )}
      {props.agentRoles.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {/*
            The expert is deliberately not among these.
            It already has its own control above, written before roles existed and stored under
            its own key. Rendering it here as well gave two pickers for one thing, backed by two
            different settings — which is the "one fact in two places" shape this project pays
            for most often, and it was reported within minutes of shipping.
          */}
          {props.agentRoles
            .filter((role) => role.role !== 'expert')
            .map((role) => (
              <ColourPicker
                key={role.role}
                label={`${role.name} colour`}
                description={`Marks answers from the ${role.name.toLowerCase()}.`}
                // Through `defaultAgentColor`, which is what actually paints the tokens. Reading
                // `DEFAULT_AGENT_COLORS` directly showed a custom role as coral here while the
                // chat painted its derived hue — the swatch and the thing it describes disagreeing.
                value={props.agentColors[role.role] ?? defaultAgentColor(role.role)}
                presets={EXPERT_PRESETS}
                fallback={defaultAgentColor(role.role)}
                inputId={`lc-agent-${role.role}-hex`}
                onChange={(hex) => props.onChangeAgentColor(role.role, hex)}
              />
            ))}
        </div>
      )}

      {/*
       * Warned rather than prevented. Two identical colours defeat the point of having two,
       * but it is a legitimate thing to want — and the expert mark icon still distinguishes
       * them — so this states the consequence and leaves the choice alone.
       */}
      {clash && (
        <p style={{ color: colors.error, fontSize: 11, margin: '0 0 14px' }}>
          These are the same colour, so expert answers will not stand out. Only the expert mark will
          tell them apart.
        </p>
      )}

      {/* Its own group, so it reads as the result of the settings above rather than another one. */}
      <div>
        <GroupHeading>Preview</GroupHeading>
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
