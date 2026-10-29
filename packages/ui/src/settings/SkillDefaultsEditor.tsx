import { useEffect, useState, type ReactElement } from 'react'

import { disabledWhen } from '../disabledWhen.js'
import { colors, monospaceFamily as monospace, secondaryButtonStyle, textFieldStyle } from '../theme.js'

/**
 * This user's answers to one skill's placeholders, so the assistant fills them in instead of
 * stopping to ask (`skills/defaults.ts` in core).
 *
 * Detected placeholders (`{{name}}`, `<NAME>`) are offered as boxes; any other name can be added,
 * because detection only suggests - a skill that says "ask for the environment" has no marker at
 * all. Stored in the user's own settings, never in the skill, so a shared skill stays shared.
 */
export function SkillDefaultsEditor(props: {
  skill: string
  placeholders: readonly string[]
  values: Record<string, string>
  onSave: (values: Record<string, string>) => void
}): ReactElement {
  const savedKey = JSON.stringify(props.values)
  const [draft, setDraft] = useState<Record<string, string>>(props.values)
  const [newName, setNewName] = useState('')
  useEffect(() => setDraft(JSON.parse(savedKey) as Record<string, string>), [savedKey])

  const names = [...new Set([...props.placeholders, ...Object.keys(draft)])]
  const stored = Object.keys(props.values).length
  const clean = (values: Record<string, string>): string =>
    JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim().length > 0).sort()))
  const dirty = clean(draft) !== clean(props.values)
  const id = (name: string): string => `lc-skill-default-${props.skill}-${name}`

  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11, color: colors.muted }}>
        {stored > 0
          ? `Your defaults (${String(stored)})`
          : props.placeholders.length > 0
            ? `Defaults for its ${String(props.placeholders.length)} input${props.placeholders.length === 1 ? '' : 's'}`
            : 'Defaults for its inputs'}
      </summary>
      <p style={{ color: colors.muted, fontSize: 11, margin: '4px 0 6px' }}>
        Answers the assistant uses when this skill asks for an input, instead of waiting for you. Kept in
        your own settings, not in the skill. Leave a box empty to be asked; what you say in a chat still wins.
      </p>
      {names.length === 0 && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 6px' }}>
          No placeholders found in its text (written as {'{{name}}'} or &lt;NAME&gt;). Add the input by name below.
        </p>
      )}
      {names.map((name) => (
        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <label htmlFor={id(name)} style={{ fontFamily: monospace, fontSize: 11, minWidth: 110, overflowWrap: 'anywhere' }}>
            {name}
          </label>
          <input
            id={id(name)}
            type="text"
            value={draft[name] ?? ''}
            spellCheck={false}
            placeholder="ask me"
            onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
            style={{ ...textFieldStyle(), flex: 1 }}
          />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
        <input
          aria-label={`Another input for ${props.skill}`}
          type="text"
          value={newName}
          spellCheck={false}
          placeholder="another input's name"
          onChange={(event) => setNewName(event.target.value)}
          style={{ ...textFieldStyle(), width: 160 }}
        />
        <button
          type="button"
          style={secondaryButtonStyle()}
          {...disabledWhen([newName.trim().length === 0, 'Type the name of the input first.'], [names.includes(newName.trim()), 'That input is already listed.'])}
          onClick={() => {
            setDraft({ ...draft, [newName.trim()]: '' })
            setNewName('')
          }}
        >
          Add
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          {...disabledWhen([!dirty, 'Nothing has changed since the last save.'])}
          onClick={() => props.onSave(draft)}
        >
          Save defaults
        </button>
      </div>
    </details>
  )
}
