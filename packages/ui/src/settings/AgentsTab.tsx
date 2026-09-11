import type { AgentRoleState } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'

import { Select } from '../Select.js'
import {
  colors,
  fontFamily,
  labelStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from '../theme.js'
import { ScopeBadge } from './ScopeBadge.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

/** The sentinel for "nobody", kept out of the profile id space. */
const NOBODY = '__none__'
/** And for the Claude CLI, which is not a profile and has no id. */
const CLI = '__cli__'

export interface AgentsTabProps {
  roles: AgentRoleState[]
  profiles: { id: string; label: string }[]
  cliAvailable: boolean
  cliReason?: string
  budgetMatters: boolean
  teamGuidance: string
  defaultTeamGuidance: string
  teamGuidanceIsDefault: boolean
  colors: Record<string, string>
  onAssign: (
    role: string,
    assignment: { kind: 'cli' | 'profile'; profileId?: string } | undefined,
  ) => void
  onSetPrompt: (role: string, prompt: string | undefined) => void
  onSetBudget: (matters: boolean) => void
  onSetTeamGuidance: (guidance: string | undefined) => void
  /** The budget controls, rendered here only when cost is worth managing. */
  budgetPanel?: ReactElement
}

/**
 * The team, and who answers for each role.
 *
 * ## What this replaced
 *
 * One expert, meaning the Claude CLI, and a tab largely about what it cost. Claude is still
 * detected and still the default for `expert`, but it is a default now: the useful question turned
 * out to be *who is the right reader for this*, not *is this hard enough for Claude*.
 *
 * ## Why every role is listed, including the empty ones
 *
 * A tab showing only what is already configured gives a new user nowhere to start. The empty rows
 * are what you click to assign somebody, and the summary beside each one is how you decide whether
 * you want to.
 *
 * ## Why cost is conditional rather than always present
 *
 * A spend cap over something nothing meters looks like protection and is not. Only a Claude
 * consultation reports a price; a gateway bills somewhere this product cannot see. So the budget
 * defaults to *whether anything meters* and the checkbox overrides that in either direction.
 */
export function AgentsTab(props: AgentsTabProps): ReactElement {
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [guidance, setGuidance] = useState(props.teamGuidance)
  const [showGuidance, setShowGuidance] = useState(false)

  // Resynced when the host answers — the panel can mount before the reply arrives, which is the
  // race that made the very first settings screen look like it had lost your data.
  useEffect(() => {
    setGuidance(props.teamGuidance)
  }, [props.teamGuidance])

  const assignedCount = props.roles.filter((role) => role.kind !== undefined).length

  function valueFor(role: AgentRoleState): string {
    if (role.kind === 'cli') return CLI
    if (role.kind === 'profile' && role.profileId !== undefined) return role.profileId
    return NOBODY
  }

  function optionsFor(): { value: string; label: string }[] {
    return [
      { value: NOBODY, label: 'Nobody — this specialist is not offered' },
      ...(props.cliAvailable ? [{ value: CLI, label: 'Claude (command line)' }] : []),
      ...props.profiles.map((profile) => ({ value: profile.id, label: profile.label })),
    ]
  }

  return (
    <div
      style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Agents</h3>
        <ScopeBadge scope="user" />
      </div>

      <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 12px', lineHeight: 1.5 }}>
        Specialists your assistant can consult while it works — to plan something hard, review what
        it just wrote, or say what would break it. Assign a model to a role and it becomes
        available; leave one as Nobody and it is simply not offered.
      </p>

      {props.cliAvailable ? (
        <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 12px' }}>
          Claude was found on this machine and is the default expert. You can put any model in that
          seat instead.
        </p>
      ) : (
        props.cliReason !== undefined && (
          <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 12px' }}>
            Claude was not found ({props.cliReason}) — any configured provider can take these roles.
          </p>
        )
      )}

      {props.profiles.length === 0 && (
        <p style={{ color: colors.error, fontSize: 11, margin: '0 0 12px' }}>
          No providers are configured yet. Add one in the Providers tab and it can take a role here.
        </p>
      )}

      {props.roles.map((role) => (
        <div
          key={role.role}
          style={{
            border: `1px solid ${colors.border}`,
            borderLeft: `3px solid ${props.colors[role.role] ?? colors.border}`,
            borderRadius: 3,
            padding: '8px 10px',
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <strong style={{ fontSize: 12 }}>{role.name}</strong>
            <span style={{ color: colors.muted, fontSize: 11, flex: 1 }}>
              {role.summary}
              {!role.promptIsDefault && ' · prompt edited'}
            </span>
            <button
              type="button"
              style={secondaryButtonStyle()}
              aria-label={`Edit the ${role.name} prompt`}
              title="What this specialist is told it is"
              onClick={() => {
                setEditing(editing === role.role ? undefined : role.role)
                setDraft(role.prompt)
              }}
            >
              {/*
                The label never changes with state.
                It briefly carried a dot when the prompt was edited, which renames the control:
                it stops being findable as "Prompt" by anything that looks a button up by name,
                including a screen reader, a keyboard user and the test that caught this. The
                edited state belongs in the row's text, where it is describing rather than naming.
              */}
              Prompt
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <Select
                value={valueFor(role)}
                onChange={(value) =>
                  props.onAssign(
                    role.role,
                    value === NOBODY
                      ? undefined
                      : value === CLI
                        ? { kind: 'cli' }
                        : { kind: 'profile', profileId: value },
                  )
                }
                options={optionsFor()}
              />
            </div>
          </div>

          {/*
            A role assigned to something that has gone says so here rather than failing at the
            moment of use — where the only reader is the model, and the user finds out from a tool
            error in the middle of a turn.
          */}
          {role.kind !== undefined && !role.available && (
            <p style={{ color: colors.error, fontSize: 11, margin: '6px 0 0' }}>
              {role.reason ?? 'This specialist cannot be reached.'}
            </p>
          )}

          {editing === role.role && (
            <div style={{ marginTop: 8 }}>
              <span style={labelStyle()}>What the {role.name.toLowerCase()} is told</span>
              <textarea
                value={draft}
                spellCheck={false}
                rows={14}
                onChange={(event) => setDraft(event.target.value)}
                style={{
                  ...textFieldStyle(),
                  fontFamily: monospace,
                  width: '100%',
                  resize: 'vertical',
                }}
              />
              <p
                style={{ color: colors.muted, fontSize: 11, margin: '4px 0 6px', lineHeight: 1.5 }}
              >
                A role is mostly its prompt — the difference between a useful reviewer and a
                flattering one is a few sentences about what to look for. Edit it to suit this
                codebase.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  style={primaryButtonStyle(false)}
                  onClick={() => {
                    props.onSetPrompt(role.role, draft)
                    setEditing(undefined)
                  }}
                >
                  Save prompt
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle()}
                  disabled={role.promptIsDefault}
                  onClick={() => {
                    props.onSetPrompt(role.role, undefined)
                    setEditing(undefined)
                  }}
                >
                  Reset to default
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle()}
                  onClick={() => setEditing(undefined)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          margin: '12px 0',
        }}
      >
        <input
          type="checkbox"
          checked={props.budgetMatters}
          onChange={(event) => props.onSetBudget(event.target.checked)}
        />
        <span style={{ fontSize: 12 }}>What consultations cost is worth managing</span>
      </label>
      <p style={{ color: colors.muted, fontSize: 11, margin: '-6px 0 12px', lineHeight: 1.5 }}>
        Only a Claude consultation reports a price. A gateway bills somewhere this cannot see, so
        with this off there is no budget to show — a cap over something nobody is counting would
        look like protection without being any.
      </p>

      {props.budgetMatters && props.budgetPanel}

      <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 12 }}>When to consult</strong>
          <span style={{ color: colors.muted, fontSize: 11, flex: 1 }}>
            Used in Agent team mode{props.teamGuidanceIsDefault ? '' : ' · edited'}
          </span>
          <button
            type="button"
            style={secondaryButtonStyle()}
            onClick={() => setShowGuidance(!showGuidance)}
          >
            {showGuidance ? 'Hide' : 'Edit'}
          </button>
        </div>
        <p style={{ color: colors.muted, fontSize: 11, margin: '6px 0 0', lineHeight: 1.5 }}>
          The assistant consults specialists on its own, without being asked. This is the judgement
          it uses about when that is worth a round trip — which differs between a prototype and a
          payments system, so it is yours to change. The list of who exists is added automatically;
          you are editing the advice, not the roster.
        </p>

        {showGuidance && (
          <div style={{ marginTop: 8 }}>
            <textarea
              value={guidance}
              spellCheck={false}
              rows={18}
              aria-label="When to consult"
              onChange={(event) => setGuidance(event.target.value)}
              style={{
                ...textFieldStyle(),
                fontFamily: monospace,
                width: '100%',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                style={primaryButtonStyle(false)}
                onClick={() => props.onSetTeamGuidance(guidance)}
              >
                Save
              </button>
              <button
                type="button"
                style={secondaryButtonStyle()}
                disabled={props.teamGuidanceIsDefault}
                onClick={() => {
                  setGuidance(props.defaultTeamGuidance)
                  props.onSetTeamGuidance(undefined)
                }}
              >
                Reset to default
              </button>
            </div>
          </div>
        )}
      </div>

      {assignedCount === 0 && (
        <p style={{ color: colors.muted, fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
          Nobody is assigned, so Agent team mode has nobody to consult and behaves like Code. Give
          at least one role a model above.
        </p>
      )}
    </div>
  )
}
