import { useEffect, useState, type ReactElement } from 'react'

import type { IndexRenamesMessage, ProjectMessage, ProjectStampMessage } from '@light-code/core/browser'

import {
  colors,
  labelStyle,
  monospaceFamily,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from '../theme.js'
import { Panel } from './Panel.js'

/**
 * Settings → Project: what this project is called, and the two one-off jobs that name changes.
 *
 * Asked for because several teams share one cluster and one bucket, and nothing said which skill,
 * tool or index belonged to which project. The name labels new skills and tools and leads every
 * derived index name; the two buttons bring what already exists into line — both preview first and
 * list exactly what they will touch, because both write to things other people read.
 */

export interface ProjectTabProps {
  project: ProjectMessage | undefined
  stamp: ProjectStampMessage | undefined
  renames: IndexRenamesMessage | undefined
  onSaveName: (name: string) => void
  onStamp: (apply: boolean) => void
  onRenames: (apply: boolean) => void
}

const hintStyle = { display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 10px' } as const
const listStyle = {
  margin: '6px 0',
  padding: 8,
  maxHeight: 220,
  overflow: 'auto',
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  fontFamily: monospaceFamily,
  fontSize: 11,
  lineHeight: 1.6,
} as const

export function ProjectTab(props: ProjectTabProps): ReactElement {
  const project = props.project
  const [name, setName] = useState(project?.configured ?? '')
  useEffect(() => setName(project?.configured ?? ''), [project?.configured])

  if (project !== undefined && !project.hasWorkspace) {
    return <p style={{ color: colors.muted }}>Open a folder first — a project name belongs to a project.</p>
  }
  const effective = project?.configured ?? project?.folder
  const dirty = name.trim() !== (project?.configured ?? '')

  return (
    <div>
      <Panel id="project.name" title="Project name" summary={effective ?? 'Loading…'} defaultOpen>
        <label htmlFor="project-name" style={labelStyle()}>
          Name
        </label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            id="project-name"
            type="text"
            value={name}
            spellCheck={false}
            placeholder={project?.folder !== undefined ? `${project.folder} (the folder name)` : 'e.g. Payments'}
            onChange={(event) => setName(event.target.value)}
            style={{ ...textFieldStyle(), flex: 1 }}
          />
          <button type="button" style={primaryButtonStyle(!dirty)} disabled={!dirty} onClick={() => props.onSaveName(name)}>
            Save
          </button>
        </div>
        <span style={hintStyle}>
          Saved for this project only, on this machine — a repository cannot set it. New skills and
          tools are labelled with it, and index names start with it. Leave it blank to use the
          folder name, which labels skills and tools but leaves index names as they are.
        </span>
        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
          <div>
            Author: <strong>{project?.author ?? 'unknown'}</strong>{' '}
            <span style={{ color: colors.muted }}>(identity.owner, or your login name)</span>
          </div>
          {project?.indexName !== undefined && (
            <div>
              Codebase index: <code style={{ fontFamily: monospaceFamily }}>{project.indexName}</code>
            </div>
          )}
        </div>
      </Panel>

      <StampPanel stamp={props.stamp} onStamp={props.onStamp} />
      <RenamesPanel renames={props.renames} configured={project?.configured} onRenames={props.onRenames} />
    </div>
  )
}

function StampPanel(props: { stamp: ProjectStampMessage | undefined; onStamp: (apply: boolean) => void }): ReactElement {
  const stamp = props.stamp
  const entries = stamp?.entries ?? []
  const approved = entries.filter((entry) => entry.kind === 'tool' && entry.approved === true).length
  return (
    <Panel id="project.stamp" title="Label existing skills and tools" forceOpen={stamp?.running === true || entries.length > 0}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        Adds author, project, version and last-updated time to skills and Python tools that do not
        have them yet. Only what is missing is added — a skill that already names its author keeps
        it. Existing files start at version 1, dated when they were last changed. Only folders this
        machine saves to are touched; a colleague&apos;s shared files are theirs to label.
      </p>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="button" style={secondaryButtonStyle()} disabled={stamp?.running === true} onClick={() => props.onStamp(false)}>
          Find unlabelled files
        </button>
        {entries.length > 0 && stamp?.running !== true && (
          <button type="button" style={primaryButtonStyle(false)} onClick={() => props.onStamp(true)}>
            Label {entries.length} file{entries.length === 1 ? '' : 's'}
          </button>
        )}
        {stamp?.running === true && <span role="status">Labelling…</span>}
      </div>
      {entries.length > 0 && (
        <div style={listStyle}>
          {entries.map((entry) => (
            <div key={entry.filePath}>
              {entry.kind === 'skill' ? 'skill' : 'tool '} {entry.name}{' '}
              <span style={{ color: colors.muted }}>
                + {Object.entries(entry.adds).map(([key, value]) => `${key}: ${String(value)}`).join(', ')}
              </span>
            </div>
          ))}
        </div>
      )}
      {approved > 0 && stamp?.running !== true && (
        <span style={hintStyle}>
          {approved} approved tool{approved === 1 ? '' : 's'} stay approved here, since only the label
          lines change. Other machines will ask to approve the labelled version once.
        </span>
      )}
      {stamp?.readOnly !== undefined && stamp.readOnly > 0 && entries.length > 0 && (
        <span style={hintStyle}>{stamp.readOnly} skill(s) from shared folders are left alone.</span>
      )}
      {stamp?.note !== undefined && <span style={hintStyle}>{stamp.note}</span>}
      {stamp?.done !== undefined && (
        <span role="status" style={hintStyle}>
          Labelled {stamp.done.written} file{stamp.done.written === 1 ? '' : 's'}
          {stamp.done.uploaded > 0 ? `, ${String(stamp.done.uploaded)} uploaded to the bucket` : ''}.
          {stamp.done.failed.length > 0 ? ` Not labelled: ${stamp.done.failed.join('; ')}` : ''}
        </span>
      )}
      {stamp?.error !== undefined && <span style={{ ...hintStyle, color: colors.error }}>{stamp.error}</span>}
    </Panel>
  )
}

function RenamesPanel(props: {
  renames: IndexRenamesMessage | undefined
  configured: string | undefined
  onRenames: (apply: boolean) => void
}): ReactElement {
  const renames = props.renames
  const plans = renames?.plans ?? []
  return (
    <Panel id="project.renames" title="Move indexes to the project's names" forceOpen={renames?.running === true || plans.length > 0}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        Once a project name is set, index names start with it. Indexes you already have are copied
        to the new names in the cluster — nothing is embedded again — and each document is labelled
        with the project on the way. The old indexes are left where they are, so nothing is lost;
        remove them from the cluster when you are happy. Names you typed yourself are not changed.
        Indexing the codebase also does this for you if it finds the old index.
      </p>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={renames?.running === true || props.configured === undefined}
          title={props.configured === undefined ? 'Set a project name first' : undefined}
          onClick={() => props.onRenames(false)}
        >
          Find indexes to move
        </button>
        {plans.length > 0 && renames?.running !== true && (
          <button type="button" style={primaryButtonStyle(false)} onClick={() => props.onRenames(true)}>
            Copy {plans.length} index{plans.length === 1 ? '' : 'es'}
          </button>
        )}
        {renames?.running === true && (
          <span role="status">
            Copying {renames.current ?? ''}… {renames.copied !== undefined ? `${String(renames.copied)} documents` : ''}
          </span>
        )}
      </div>
      {plans.length > 0 && (
        <div style={listStyle}>
          {plans.map((plan) => (
            <div key={plan.from}>
              {plan.kind}: {plan.from} → {plan.to}
            </div>
          ))}
        </div>
      )}
      {renames?.note !== undefined && <span style={hintStyle}>{renames.note}</span>}
      {renames?.done !== undefined && (
        <span role="status" style={hintStyle}>
          {renames.done.map((entry) => `Copied ${String(entry.copied)} documents to ${entry.to}; ${entry.from} is still there.`).join(' ')}
        </span>
      )}
      {renames?.error !== undefined && <span style={{ ...hintStyle, color: colors.error }}>{renames.error}</span>}
    </Panel>
  )
}
