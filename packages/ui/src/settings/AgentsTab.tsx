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
  /** Creates or updates a role the user invented. The id is fixed once created. */
  onSaveCustomRole: (role: {
    id: string
    name: string
    summary: string
    prompt: string
    usesTools: boolean
    canWrite: boolean
  }) => void
  onDeleteCustomRole: (id: string) => void
  /** Turns one role's workspace access on or off. */
  onSetRoleTools: (role: string, usesTools: boolean) => void
  /** Turns one role's ability to change things on or off. Every change is still approved. */
  onSetRoleWrite: (role: string, canWrite: boolean) => void
  /** Switches a role in or out of play, keeping everything it was configured with. */
  onSetRoleEnabled: (role: string, enabled: boolean) => void
  /** How many custom roles may exist, so the form can say so before the save fails. */
  customRoleLimit: number
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
  /** Which delete has been clicked once. Two clicks, because it takes a written prompt with it. */
  const [confirmed, setConfirmed] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [newRole, setNewRole] = useState({
    id: '',
    name: '',
    summary: '',
    prompt: '',
    usesTools: true,
    // Off: a role invented in a hurry should not be able to edit the repository because nobody
    // thought about the box.
    canWrite: false,
  })

  const customCount = props.roles.filter((role) => role.custom === true).length
  const roomForMore = customCount < props.customRoleLimit
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
            // Dimmed rather than hidden: a role you switched off is one you will switch back on,
            // and a list that dropped it would leave you hunting for where it went.
            ...(role.enabled ? {} : { opacity: 0.55 }),
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            {/*
              In the header, because it is about the role rather than about its configuration —
              and first, because everything below it is conditional on it. Unassigning is the other
              way to switch a role off, and the two are kept distinct on purpose: that one forgets
              who answered, this one keeps the model, the prompt and the flags exactly as set.
            */}
            <input
              type="checkbox"
              aria-label={`${role.name} enabled`}
              title={
                role.enabled
                  ? `Stop using the ${role.name.toLowerCase()}, keeping its settings`
                  : `Use the ${role.name.toLowerCase()} again`
              }
              checked={role.enabled}
              onChange={(event) => props.onSetRoleEnabled(role.role, event.target.checked)}
            />
            <strong style={{ fontSize: 12, ...(role.enabled ? {} : { color: colors.muted }) }}>
              {role.name}
            </strong>
            {/*
              Said in words when it is off.

              Reported as "I don't see the enable or disable switch" — and the control was there,
              an unlabelled checkbox beside the name with two labelled ones underneath it. A
              checkbox with no text is findable only by someone already looking for it. The dimmed
              row says something is different; this says what, and gives the eye somewhere to land.
            */}
            {!role.enabled && (
              <span
                style={{
                  color: colors.muted,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 999,
                  padding: '0 6px',
                  fontSize: 10,
                  lineHeight: '15px',
                }}
              >
                off
              </span>
            )}
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
            {role.custom === true && (
              <button
                type="button"
                style={secondaryButtonStyle()}
                aria-label={`Delete the ${role.name} role`}
                title="Remove this role and its assignment"
                onClick={() => {
                  // Confirmed because it takes the prompt with it, and a prompt somebody wrote
                  // and tuned is not something to lose to a mis-click.
                  if (confirmed === role.role) props.onDeleteCustomRole(role.role)
                  else setConfirmed(role.role)
                }}
              >
                {confirmed === role.role ? 'Really delete?' : 'Delete'}
              </button>
            )}
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
            Whether this specialist may look things up for itself.
            Shown per role because the right answer differs: a librarian that cannot read what is
            written down is answering from whatever was pasted at it, while a programmer handed a
            spec spends its lookups on nothing. Each costs a round trip, so it is a choice.
          */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 6,
              fontSize: 11,
              color: colors.muted,
            }}
          >
            <input
              type="checkbox"
              // Named, like the switch above it. A test found the first checkbox on the page by
              // position and silently retargeted when another was added -- twice now, which is
              // twice more than a selector that says what it means would have cost.
              aria-label={`${role.name} can read the workspace`}
              checked={role.usesTools}
              onChange={(event) => props.onSetRoleTools(role.role, event.target.checked)}
            />
            Can read and search the workspace
          </label>

          {/*
            Changing things, which is off everywhere by default.

            Worth its own line rather than a second clause on the one above: reading is a cost
            question and this is a trust question, and they are not the same decision. The label
            says the approval is part of it, because a checkbox reading only "can write" would be
            agreed to by people who would not have agreed to what it does.
          */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 4,
              fontSize: 11,
              color: colors.muted,
            }}
          >
            <input
              type="checkbox"
              aria-label={`${role.name} can change things`}
              checked={role.canWrite}
              onChange={(event) => props.onSetRoleWrite(role.role, event.target.checked)}
            />
            Can edit files and record skills — you approve each change
          </label>

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

      {/*
        Inventing a role.

        The five built-in ones cover most of a development cycle, and the ones people want next are
        almost always a reviewer with a different brief — security, performance, accessibility, or
        one that knows this codebase's own conventions. A role *is* its prompt, so this is the
        whole feature: a name, what it is for, and what it is told.

        Capped, and the cap is stated up front rather than discovered when saving fails. The expert
        allocates from this list and its judgement is what a longer one costs.
      */}
      {adding ? (
        <div
          style={{
            border: `1px solid ${colors.border}`,
            borderRadius: 3,
            padding: '8px 10px',
            marginBottom: 8,
          }}
        >
          <span style={labelStyle()}>Name</span>
          <input
            value={newRole.name}
            placeholder="Security reviewer"
            style={{ ...textFieldStyle(), width: '100%' }}
            onChange={(event) => {
              const name = event.target.value
              setNewRole((current) => ({
                ...current,
                name,
                // Suggested from the name until the user types one themselves, because the id has
                // rules the name does not and nobody wants to learn them to make a role.
                id:
                  current.id.length === 0 || current.id === slug(current.name)
                    ? slug(name)
                    : current.id,
              }))
            }}
          />

          <span style={labelStyle()}>Id</span>
          <input
            value={newRole.id}
            placeholder="security"
            style={{ ...textFieldStyle(), width: '100%' }}
            onChange={(event) => setNewRole((current) => ({ ...current, id: event.target.value }))}
          />
          <p style={{ color: colors.muted, fontSize: 11, margin: '2px 0 0' }}>
            What the assistant types to reach it (<code>ask_agent {newRole.id || 'security'}</code>
            ). Lowercase letters, digits and hyphens. It cannot be changed later.
          </p>

          <span style={labelStyle()}>What it is for</span>
          <input
            value={newRole.summary}
            placeholder="Threat model and attack surface"
            style={{ ...textFieldStyle(), width: '100%' }}
            onChange={(event) =>
              setNewRole((current) => ({ ...current, summary: event.target.value }))
            }
          />
          <p style={{ color: colors.muted, fontSize: 11, margin: '2px 0 0' }}>
            One line. Every specialist sees it on the roster, and it is what the expert allocates
            from when it writes a plan.
          </p>

          <span style={labelStyle()}>What it is told</span>
          <textarea
            value={newRole.prompt}
            rows={8}
            spellCheck={false}
            placeholder={
              'You review changes for security. Look for what the code trusts, where untrusted ' +
              'input reaches a decision, and what an attacker controls...'
            }
            style={{ ...textFieldStyle(), width: '100%', resize: 'vertical' }}
            onChange={(event) =>
              setNewRole((current) => ({ ...current, prompt: event.target.value }))
            }
          />
          <p style={{ color: colors.muted, fontSize: 11, margin: '2px 0 0' }}>
            Its system prompt. What it may and may not do is added automatically, so it cannot be
            left out by accident.
          </p>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 6,
              fontSize: 11,
              color: colors.muted,
            }}
          >
            <input
              type="checkbox"
              checked={newRole.usesTools}
              onChange={(event) =>
                setNewRole((current) => ({ ...current, usesTools: event.target.checked }))
              }
            />
            Can read and search the workspace
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 4,
              fontSize: 11,
              color: colors.muted,
            }}
          >
            <input
              type="checkbox"
              checked={newRole.canWrite}
              onChange={(event) =>
                setNewRole((current) => ({ ...current, canWrite: event.target.checked }))
              }
            />
            Can edit files and record skills — you approve each change
          </label>

          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <button
              type="button"
              style={primaryButtonStyle(newRole.name.trim().length === 0)}
              disabled={newRole.name.trim().length === 0}
              onClick={() => {
                props.onSaveCustomRole({ ...newRole, id: newRole.id.trim().toLowerCase() })
                setAdding(false)
                setNewRole({
                  id: '',
                  name: '',
                  summary: '',
                  prompt: '',
                  usesTools: true,
                  canWrite: false,
                })
              }}
            >
              Add role
            </button>
            <button type="button" style={secondaryButtonStyle()} onClick={() => setAdding(false)}>
              Cancel
            </button>
            <span style={{ color: colors.muted, fontSize: 11 }}>
              Assign a model to it once it exists.
            </span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={!roomForMore}
          title={
            roomForMore
              ? 'Invent a role of your own'
              : `The limit is ${String(props.customRoleLimit)} custom roles.`
          }
          onClick={() => setAdding(true)}
        >
          Add a role
          {customCount > 0 && (
            <span style={{ color: colors.muted }}>
              {' '}
              ({customCount}/{props.customRoleLimit})
            </span>
          )}
        </button>
      )}

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
          // Named, so nothing has to find it by position. A test did, and adding a checkbox above
          // it silently retargeted that test at a different control.
          aria-label="What consultations cost is worth managing"
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

/**
 * A name turned into a usable id.
 *
 * Suggested rather than enforced: the id has rules the name does not — lowercase, no spaces,
 * because it reaches a CSS custom property, a config key and a tool argument — and nobody should
 * have to learn them to invent a role. Typing over it stops the suggestion.
 */
function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}
