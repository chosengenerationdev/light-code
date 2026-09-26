import type { ApprovableGroup, CommandRules, WorkspaceApprovals } from '@light-code/core/browser'
import { TrashIcon } from '../icons.js'
import { CommandRulesSection, type CommandRulesSectionProps } from './CommandRules.js'
import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { colors, fontFamily, iconButtonStyle, labelStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'

export interface ApprovalsTabProps {
  approvals: WorkspaceApprovals
  onSetAutoApprove: (group: ApprovableGroup, enabled: boolean) => void
  onRevokeTool: (toolName: string) => void
  onRevokeCommand: (command: string) => void
  maxIterations: number
  onSetMaxIterations: (value: number) => void
  /** Folders tools may read outside the workspace. */
  readRoots: string[]
  onSetReadRoots: (roots: string[]) => void
  /** The user's own command rules, global rather than per workspace. */
  commandRules: CommandRules
  onSetCommandRules: (rules: CommandRules) => void
  /** The active mode, so the rules panel can say whether the safe list is in force. */
  modeId?: string | undefined
  /** The resolved shell, reported by the host. */
  shell?: CommandRulesSectionProps['shell']
}

const monospace = 'var(--vscode-editor-font-family, monospace)'

const CATEGORIES: { group: ApprovableGroup; label: string; description: string }[] = [
  { group: 'read', label: 'Reading files', description: 'read_file, list_files, search_files' },
  { group: 'edit', label: 'Editing files', description: 'write_to_file, apply_diff' },
  { group: 'command', label: 'Running commands', description: 'execute_command — the broadest grant here' },
  { group: 'mcp', label: 'MCP tools', description: 'Tools provided by external MCP servers' },
]

function Toggle(props: { checked: boolean; label: string; description: string; onChange: (v: boolean) => void }): ReactElement {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10, cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        style={{ marginTop: 2 }}
      />
      <span>
        <span style={{ display: 'block', fontSize: 13 }}>{props.label}</span>
        <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>{props.description}</span>
      </span>
    </label>
  )
}

function RevocableList(props: {
  title: string
  empty: string
  entries: string[]
  onRevoke: (entry: string) => void
}): ReactElement {
  return (
    <div style={{ marginTop: 16 }}>
      <label style={labelStyle()}>{props.title}</label>
      {props.entries.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 12, margin: 0 }}>{props.empty}</p>
      ) : (
        props.entries.map((entry) => (
          <div
            key={entry}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 0',
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <code style={{ flex: 1, fontFamily: monospace, fontSize: 12, wordBreak: 'break-all' }}>{entry}</code>
            <button
              type="button"
              title="Revoke this permission"
              aria-label="Revoke this permission"
              style={{ ...iconButtonStyle('secondary'), color: colors.error }}
              onClick={() => props.onRevoke(entry)}
            >
              <TrashIcon />
            </button>
          </div>
        ))
      )}
    </div>
  )
}

export function ApprovalsTab(props: ApprovalsTabProps): ReactElement {
  const auto = props.approvals.autoApprove ?? {}
  const [steps, setSteps] = useState(String(props.maxIterations))

  // Resynced from the host, which is authoritative — the reply can arrive after mount.
  useEffect(() => setSteps(String(props.maxIterations)), [props.maxIterations])

  const parsedSteps = Number.parseInt(steps, 10)
  const stepsValid = Number.isFinite(parsedSteps) && parsedSteps >= 1 && parsedSteps <= 500

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily }}>
      <h3 style={{ margin: '0 0 4px', color: colors.foreground }}>Approvals</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0, marginBottom: 12 }}>
        These apply to this workspace only, and are stored outside it — a repository cannot grant itself permissions.
      </p>

      <Panel
        id="approvals.auto"
        title="Skipping the prompt"
        summary={CATEGORIES.filter((category) => auto[category.group] === true).map((category) => category.label).join(', ') || 'Always ask'}
        defaultOpen
      >
      <label style={labelStyle()}>Skip the prompt for…</label>
      {CATEGORIES.map((category) => (
        <Toggle
          key={category.group}
          checked={auto[category.group] === true}
          label={category.label}
          description={category.description}
          onChange={(enabled) => props.onSetAutoApprove(category.group, enabled)}
        />
      ))}

      <RevocableList
        title="Always-allowed tools"
        empty="None. Use “Always allow” on an approval prompt to add one."
        entries={props.approvals.allowedTools ?? []}
        onRevoke={props.onRevokeTool}
      />

      <RevocableList
        title="Always-allowed commands (exact match)"
        empty="None. Use “Always allow this command” on a command prompt to add one."
        entries={props.approvals.allowedCommands ?? []}
        onRevoke={props.onRevokeCommand}
      />
      <p style={{ color: colors.muted, fontSize: 11 }}>
        A command is matched byte-for-byte. Allowing <code style={{ fontFamily: monospace }}>npm test</code> does not
        allow <code style={{ fontFamily: monospace }}>npm test &amp;&amp; something-else</code>.
      </p>
      </Panel>

      <Panel id="approvals.commands" title="Commands and the shell">
      <CommandRulesSection
        rules={props.commandRules}
        onSave={props.onSetCommandRules}
        {...(props.modeId !== undefined ? { modeId: props.modeId } : {})}
        {...(props.shell !== undefined ? { shell: props.shell } : {})}
      />
      </Panel>

      <Panel
        id="approvals.readRoots"
        title="Folders it may read"
        summary={`${String(props.readRoots.length)} outside the workspace`}
      >
      <ReadRootsSection roots={props.readRoots} onSave={props.onSetReadRoots} />
      </Panel>

      <Panel id="approvals.steps" title="Maximum steps per message" summary={String(props.maxIterations)}>
      <div>
        <label htmlFor="lc-max-steps" style={labelStyle()}>
          Maximum steps per message
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            id="lc-max-steps"
            type="number"
            min={1}
            max={500}
            value={steps}
            onChange={(event) => setSteps(event.target.value)}
            style={{ ...textFieldStyle(), width: 110, flex: 'none' }}
          />
          <button
            type="button"
            style={secondaryButtonStyle()}
            disabled={!stepsValid || parsedSteps === props.maxIterations}
            onClick={() => props.onSetMaxIterations(parsedSteps)}
          >
            Save
          </button>
          {!stepsValid && <span style={{ fontSize: 11, color: colors.error }}>Must be between 1 and 500.</span>}
        </div>
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
          How many tool calls the assistant may make in reply to one message. The limit exists so a
          model looping on a failing edit stops costing money — not to cut short real work. Hitting
          it loses nothing: send another message and it carries on. Raise it for long refactors;
          lower it if you want to stay closer to what it is doing.
        </span>
      </div>

      </Panel>

    </div>
  )
}

/**
 * Folders the assistant may read outside the workspace.
 *
 * Confinement to the workspace is the default for good reason, but "the logs are on a share"
 * is an ordinary situation — and on Windows that is a UNC path no amount of workspace-relative
 * resolution will ever reach.
 *
 * **Reading only, and the note says so.** Writing stays confined whatever is listed here,
 * because checkpoints snapshot the workspace and an edit elsewhere would have no rollback —
 * silently removing the safety net at the moment it matters most.
 */
function ReadRootsSection(props: { roots: string[]; onSave: (roots: string[]) => void }): ReactElement {
  const [draft, setDraft] = useState<string[]>(props.roots)
  useEffect(() => setDraft(props.roots), [props.roots])

  const dirty = draft.join(' ') !== props.roots.join(' ')

  return (
    <section style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
      <span style={labelStyle()}>Folders it may read</span>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        Everything is confined to this workspace by default. Add a folder here to let the
        assistant read files elsewhere — a log directory, or a network share such as{' '}
        <code style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{String.raw`\server\logs`}</code>.
        It can <strong>read</strong> these, never write to them: edits stay in the workspace,
        where a checkpoint can undo them.
      </p>

      {draft.map((root, index) => (
        <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <input
            type="text"
            value={root}
            spellCheck={false}
            aria-label={`Readable folder ${index + 1}`}
            placeholder={String.raw`\server\share\logs`}
            onChange={(event) =>
              setDraft((current) => current.map((entry, position) => (position === index ? event.target.value : entry)))
            }
            style={{ ...textFieldStyle(), fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
          />
          <button
            type="button"
            title="Remove this folder"
            aria-label="Remove this folder"
            style={iconButtonStyle('secondary')}
            onClick={() => setDraft((current) => current.filter((_, position) => position !== index))}
          >
            <TrashIcon />
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" style={secondaryButtonStyle()} onClick={() => setDraft((current) => [...current, ''])}>
          Add a folder
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={!dirty}
          onClick={() => props.onSave(draft.map((root) => root.trim()).filter((root) => root.length > 0))}
        >
          {dirty ? 'Save folders' : 'Saved'}
        </button>
      </div>
    </section>
  )
}
