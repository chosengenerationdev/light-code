import { isValidVariableName, type ResolvedVariable, type SessionVariable } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { TrashIcon } from '../icons.js'
import { badgeStyle, colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface VariablesTabProps {
  user: SessionVariable[]
  admin: SessionVariable[]
  /** What a command will actually see, with the winner's scope on each entry. */
  resolved: ResolvedVariable[]
  adminIds: string[]
  /** False when the administrator's half is read-only for this session. */
  canEditAdmin: boolean
  onSaveUser: (variables: SessionVariable[]) => void
  onSaveAdmin: (variables: SessionVariable[]) => void
  onSaveAdminIds: (ids: string[]) => void
}

/**
 * Values a session hands to the commands and tools it runs.
 *
 * Two scopes, and the panel's job is to make the precedence visible. An administrator's variable
 * wins over a user's of the same name, so a user editing one that is being overridden would
 * otherwise change a value that never takes effect and see no sign of it — the row says so, and
 * shows both.
 */
export function VariablesTab(props: VariablesTabProps): ReactElement {
  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}>
      <h3 style={{ margin: '0 0 4px' }}>Variables</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0 }}>
        Set as environment variables for everything a session runs — shell commands and Python
        tools.
      </p>

      {/*
        Said here, where a value is typed, and not only in the hosting document. Someone entering
        a value is entitled to know who can read it, and the answer is "anyone else using this
        server", because every session spawns processes as the same account.
      */}
      <p
        style={{
          color: colors.error,
          fontSize: 11,
          border: `1px solid ${colors.error}`,
          borderRadius: 8,
          padding: 8,
          margin: '0 0 12px',
        }}
      >
        <strong>Not secret.</strong> Everything a session runs does so as the server&rsquo;s own
        account, so another user can have their assistant read these. Put an API key in{' '}
        <strong>Providers</strong>, which stores it separately and never sends it back to a page.
      </p>

      <VariableList
        title="Yours"
        hint="Only your sessions see these."
        variables={props.user}
        resolved={props.resolved}
        scope="user"
        onSave={props.onSaveUser}
        editable
      />

      <VariableList
        title="Everyone's"
        hint={
          props.canEditAdmin
            ? 'Applied to every user, and these win where a name collides with someone’s own.'
            : 'Set by an administrator. These win where a name collides with your own.'
        }
        variables={props.admin}
        resolved={props.resolved}
        scope="admin"
        onSave={props.onSaveAdmin}
        editable={props.canEditAdmin}
      />

      {props.canEditAdmin && <AdminIds ids={props.adminIds} onSave={props.onSaveAdminIds} />}
    </div>
  )
}

function VariableList(props: {
  title: string
  hint: string
  variables: SessionVariable[]
  resolved: ResolvedVariable[]
  scope: 'user' | 'admin'
  editable: boolean
  onSave: (variables: SessionVariable[]) => void
}): ReactElement {
  const [draft, setDraft] = useState<SessionVariable[]>(props.variables)
  const [dirty, setDirty] = useState(false)

  /*
   * Resynced when the host sends a new list, but only while untouched. Overwriting a half-typed
   * row because another user's save triggered a broadcast would lose work with no warning.
   */
  useEffect(() => {
    if (!dirty) setDraft(props.variables)
  }, [props.variables, dirty])

  const change = (index: number, patch: Partial<SessionVariable>): void => {
    setDirty(true)
    setDraft((current) => current.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)))
  }

  const invalid = draft.filter((entry) => entry.name.length > 0 && !isValidVariableName(entry.name))
  const blank = draft.some((entry) => entry.name.trim().length === 0)

  return (
    <section style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
      <span style={labelStyle()}>{props.title}</span>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>{props.hint}</p>

      {draft.length === 0 && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>None set.</p>
      )}

      {draft.map((entry, index) => {
        const winner = props.resolved.find((candidate) => candidate.name === entry.name)
        // Only meaningful in the user's list: an admin variable is never the one displaced.
        const overridden = props.scope === 'user' && winner !== undefined && winner.scope === 'admin'
        const badName = entry.name.length > 0 && !isValidVariableName(entry.name)

        return (
          <div key={index} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                aria-label="Variable name"
                value={entry.name}
                spellCheck={false}
                disabled={!props.editable}
                placeholder="NAME"
                onChange={(event) => change(index, { name: event.target.value })}
                style={{ ...textFieldStyle(), width: 170, fontFamily: monospace, ...(badName ? { borderColor: colors.error } : {}) }}
              />
              <input
                type="text"
                aria-label="Variable value"
                value={entry.value}
                spellCheck={false}
                disabled={!props.editable}
                placeholder="value"
                onChange={(event) => change(index, { value: event.target.value })}
                style={{ ...textFieldStyle(), flex: 1, minWidth: 140, fontFamily: monospace }}
              />
              {props.editable && (
                <button
                  type="button"
                  aria-label={`Remove ${entry.name}`}
                  title="Remove"
                  style={secondaryButtonStyle()}
                  onClick={() => {
                    setDirty(true)
                    setDraft((current) => current.filter((_, position) => position !== index))
                  }}
                >
                  <TrashIcon />
                </button>
              )}
            </div>

            {badName && (
              <div style={{ color: colors.error, fontSize: 10, marginTop: 2 }}>
                Letters, digits and underscore only, not starting with a digit — anything else
                cannot be set as an environment variable.
              </div>
            )}

            {/*
              The point of the whole panel. Without this a user edits a value that will never
              apply and sees nothing to say so.
            */}
            {overridden && (
              <div style={{ color: colors.muted, fontSize: 10, marginTop: 2 }}>
                <span style={{ ...badgeStyle(), fontSize: 9, marginRight: 4 }}>overridden</span>
                An administrator set {entry.name} for everyone, so sessions use{' '}
                <code style={{ fontFamily: monospace }}>{winner.value}</code> and not yours.
              </div>
            )}
          </div>
        )
      })}

      {props.editable && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            style={secondaryButtonStyle()}
            onClick={() => {
              setDirty(true)
              setDraft((current) => [...current, { name: '', value: '' }])
            }}
          >
            Add
          </button>
          <button
            type="button"
            style={primaryButtonStyle(!dirty || invalid.length > 0 || blank)}
            disabled={!dirty || invalid.length > 0 || blank}
            onClick={() => {
              props.onSave(draft.map((entry) => ({ ...entry, name: entry.name.trim() })))
              setDirty(false)
            }}
          >
            Save
          </button>
          {blank && <span style={{ color: colors.muted, fontSize: 11 }}>A name is required.</span>}
        </div>
      )}
    </section>
  )
}

/**
 * Who counts as an administrator.
 *
 * Editable here so adding a colleague does not mean restarting the server, and `--admin-id` still
 * wins at startup — which is the way back in for someone who removes themselves.
 */
function AdminIds(props: { ids: string[]; onSave: (ids: string[]) => void }): ReactElement {
  const [text, setText] = useState(props.ids.join('\n'))
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!dirty) setText(props.ids.join('\n'))
  }, [props.ids, dirty])

  return (
    <section style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
      <span style={labelStyle()}>Administrators</span>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        One identity id per line — the immutable id your directory issues, not a username, which
        gets reassigned when someone leaves. Removing yourself is allowed; the way back is{' '}
        <code style={{ fontFamily: monospace }}>--admin-id</code> on the command line.
      </p>
      <textarea
        aria-label="Administrator ids"
        value={text}
        spellCheck={false}
        rows={4}
        onChange={(event) => {
          setDirty(true)
          setText(event.target.value)
        }}
        style={{ ...textFieldStyle(), width: '100%', fontFamily: monospace, resize: 'vertical' }}
      />
      <button
        type="button"
        style={{ ...primaryButtonStyle(!dirty), marginTop: 8 }}
        disabled={!dirty}
        onClick={() => {
          props.onSave(
            text
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          )
          setDirty(false)
        }}
      >
        Save
      </button>
    </section>
  )
}
