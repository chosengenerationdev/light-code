import { useEffect, useState, type ReactElement } from 'react'
import { badgeStyle, colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { FolderListEditor } from './FolderListEditor.js'
import { DismissableProblems } from './DismissableProblems.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface SkillsTabProps {
  skills: { name: string; description: string; filePath: string; sourceDir?: string; always?: boolean }[]
  issues: { filePath: string; detail: string }[]
  /** Where new skills are written. Undefined when no folder is open. */
  skillsDir?: string | undefined
  /** Read-only folders searched after `skillsDir`. */
  extraDirs: string[]
  /** The configured value rather than the resolved one, so the field round-trips what was typed. */
  configuredDir: string
  onDelete: (name: string) => void
  /** Opens the skill in an editor tab. A skill is markdown; editing it is editing a file. */
  onOpenFile: (path: string) => void
  /** Opens the standing-instructions skill, creating it from a template the first time. */
  onOpenStandingSkill: () => void
  /**
   * Reindexes skill documentation only.
   *
   * It happens on its own a few seconds after any change, so this is for the times you would
   * rather not wonder — and it is scoped to skills, so pressing it cannot disturb tools.
   */
  onReindex: () => void
  indexing: boolean
  /** The last run, as one line. Undefined when nothing has run in this session. */
  indexResult: string | undefined
  onSaveDirs: (dir: string, paths: string[]) => void
  /**
   * The team's shared skills.
   *
   * `alias` is what the team agreed to call the pool; without one there is nothing to publish
   * to and the section explains that rather than offering a button that cannot work.
   */
  team: {
    alias: string | undefined
    onSaveAlias: (alias: string) => void
    onPublish: () => void
    result: { count?: number; collection?: string; error?: string } | undefined
  }
}

/**
 * What the model has been told to remember about this workspace.
 *
 * The tab exists mainly so the list is *visible*. A skill's description is injected into every
 * future conversation, so it is not something the user should have to browse the filesystem to
 * discover — and a malformed one was previously dropped with nothing but a log line.
 */
/**
 * Pooling skills across a team.
 *
 * User-requested and called important: *"eventually i want to collect skills from all the team
 * members and maintain common skills storage"*. Everyone keeps their own collection and an alias
 * makes them searchable together — the same shape as codebase indexes, and for the same reason:
 * one shared collection would have every republish racing every other.
 *
 * Publishing is a button rather than something that happens on save. Sending what you have
 * taught your assistant to colleagues is a decision, and one worth making deliberately.
 */
function TeamSkillsSection(props: SkillsTabProps['team']): ReactElement {
  const [alias, setAlias] = useState(props.alias ?? '')
  useEffect(() => setAlias(props.alias ?? ''), [props.alias])

  return (
    <section style={{ marginTop: 18, borderTop: `1px solid ${colors.border}`, paddingTop: 14 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>Team skills</h3>
      <p style={{ margin: '0 0 8px', color: colors.muted, fontSize: 11 }}>
        One name covering every teammate&rsquo;s skills, so the assistant can search what other
        people have taught theirs. Everyone publishes to their own collection; set the same alias
        on each machine. Colleagues&rsquo; skills are returned in full, because they have no file
        on your disk to open. <strong>OpenSearch only.</strong>
      </p>

      <label htmlFor="lc-skills-alias" style={labelStyle()}>
        Shared skills alias <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
      </label>
      <input
        id="lc-skills-alias"
        type="text"
        value={alias}
        spellCheck={false}
        placeholder="e.g. my-team-skills"
        onChange={(event) => setAlias(event.target.value)}
        style={textFieldStyle()}
      />

      {/*
        Two separate acts, and the labels say which is which.

        "Save alias" was doing double duty in people's heads: naming the pool and sending skills
        to it are different things, and only the second moves any data. Step numbers make the
        order explicit, because the second cannot work before the first.
      */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={alias.trim() === (props.alias ?? '')}
          onClick={() => props.onSaveAlias(alias.trim())}
        >
          {alias.trim() === (props.alias ?? '') ? '1. Name saved' : '1. Save this name'}
        </button>
        <button
          type="button"
          style={primaryButtonStyle(props.alias === undefined)}
          disabled={props.alias === undefined}
          title={props.alias === undefined ? 'Save the name first' : 'Embeds your skills and writes them to the shared collection'}
          onClick={props.onPublish}
        >
          2. Send my skills to the team
        </button>
      </div>

      {props.result?.error !== undefined && (
        <span style={{ display: 'block', color: colors.error, fontSize: 11, marginTop: 6 }}>
          {props.result.error}
        </span>
      )}
      {props.result?.error === undefined && props.result?.count !== undefined && (
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 6 }}>
          {`Published ${String(props.result.count)} skill(s) to "${props.result.collection ?? ''}". `}
          Sending again replaces your own copies and never touches anyone else&rsquo;s.
        </span>
      )}
    </section>
  )
}

export function SkillsTab(props: SkillsTabProps): ReactElement {
  const [confirming, setConfirming] = useState<string | undefined>(undefined)

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}>
      {/* First, because it is the part people come here looking for. */}
      <TeamSkillsSection {...props.team} />
      <h3 style={{ margin: '0 0 4px' }}>Skills</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0 }}>
        Notes the assistant keeps about this workspace — internal libraries, conventions, anything
        you would otherwise explain again each time. Tell it something durable and it will offer to
        record one; you approve the text before it is written.
      </p>
      <p style={{ color: colors.muted, fontSize: 11 }}>
        Only each <strong>description</strong> below is loaded into every conversation. The bodies are
        read on demand, so a long skill costs nothing until it is relevant.
        {props.skillsDir !== undefined && (
          <>
            {' '}
            They are plain markdown in <code style={{ fontFamily: monospace }}>{props.skillsDir}</code>, so
            they land in git and can be reviewed like any other file.
          </>
        )}
      </p>

      {/*
        The standing instructions, given their own line.

        A skill with `always: true` behaves differently from every other one — its whole body is in
        every request rather than its description — and the flag is a line of frontmatter that
        silently does nothing when mistyped. Neither of those should be discoverable only by
        reading the source, so the tab states which skill it is, or offers to create it.
      */}
      <div
        style={{
          margin: '10px 0',
          padding: 10,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Standing instructions</div>
        {(() => {
          const standing = props.skills.find((skill) => skill.always === true)
          return standing === undefined ? (
            <>
              <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
                One skill can be included in <strong>every</strong> session, in full, rather than
                offered by name — for the things you would otherwise repeat at the start of each
                conversation. It is paid for on every request, so keep it short.
              </p>
              <button type="button" style={secondaryButtonStyle()} onClick={props.onOpenStandingSkill}>
                Create standing instructions
              </button>
            </>
          ) : (
            <>
              <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
                <strong>{standing.name}</strong> is included in every session, in full. Remove{' '}
                <code style={{ fontFamily: monospace }}>always: true</code> from its frontmatter to make
                it an ordinary skill again.
              </p>
              <button type="button" style={secondaryButtonStyle()} onClick={props.onOpenStandingSkill}>
                Edit standing instructions
              </button>
            </>
          )
        })()}
      </div>

      {/*
        Shown rather than only logged. A skill that is silently not offered is impossible to
        diagnose from the chat — the same reasoning as refused Python tools.
      */}
      <DismissableProblems
        title="Not loaded"
        problems={props.issues.map((issue) => `${issue.filePath} — ${issue.detail}`)}
      />

      <div style={{ marginTop: 14 }}>
        {props.skills.length === 0 ? (
          <p style={{ color: colors.muted, fontSize: 12 }}>
            {props.skillsDir === undefined
              ? 'Open a folder — skills belong to a workspace.'
              : 'None yet. Explain something about this codebase and the assistant will offer to record it.'}
          </p>
        ) : (
          props.skills.map((skill) => (
            <div key={skill.name} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <strong style={{ fontFamily: monospace, fontSize: 12 }}>{skill.name}</strong>
                {/*
                  Marked rather than hidden. A skill from a shared folder behaves identically
                  in conversation, so the only place the difference shows is here — and the
                  Remove button being absent needs an explanation beside it.
                */}
                {skill.sourceDir !== undefined && props.skillsDir !== undefined && skill.sourceDir !== props.skillsDir && (
                  <span style={{ ...badgeStyle(), fontSize: 9 }} title={`Read-only, from ${skill.sourceDir}`}>
                    shared
                  </span>
                )}
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {/*
                    Offered for shared skills too. Reading one is how you find out what the
                    assistant has been told about your codebase, and that is worth having
                    whether or not you may edit it.
                  */}
                  <button
                    type="button"
                    style={secondaryButtonStyle()}
                    title="Open this skill in an editor tab"
                    onClick={() => props.onOpenFile(skill.filePath)}
                  >
                    Open
                  </button>
                  {skill.sourceDir === undefined || props.skillsDir === undefined || skill.sourceDir === props.skillsDir ? (
                    <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(skill.name)}>
                      Remove
                    </button>
                  ) : (
                    <span style={{ color: colors.muted, fontSize: 10 }}>read-only</span>
                  )}
                </span>
              </div>
              <div style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{skill.description}</div>
              <div style={{ color: colors.muted, fontSize: 10, fontFamily: monospace, marginTop: 2 }}>
                {skill.filePath}
              </div>

              {confirming === skill.name && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12 }}>
                  <span>Delete this skill file?</span>
                  <button
                    type="button"
                    style={primaryButtonStyle(false)}
                    onClick={() => {
                      props.onDelete(skill.name)
                      setConfirming(undefined)
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(undefined)}>
                    Keep
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      {/*
        Placed with the folders rather than beside each skill: it is about the corpus as a whole,
        and the automatic reindex already covers the ordinary case a few seconds after a change.
      */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <button type="button" style={secondaryButtonStyle()} disabled={props.indexing} onClick={props.onReindex}>
          {props.indexing ? 'Reindexing…' : 'Reindex skills'}
        </button>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          {props.indexResult ??
            'Reindexed automatically a few seconds after any change. This forces it now, for skills only.'}
        </span>
      </div>

      <FolderListEditor
        primary={props.configuredDir}
        primaryPlaceholder={props.skillsDir ?? '.lightcode/skills'}
        primaryLabel="Where new skills are saved"
        primaryHint="Leave blank for .lightcode/skills in the workspace. Creating, editing and deleting all happen here."
        extras={props.extraDirs}
        extrasLabel="Also read skills from"
        extrasHint="Shared or reference folders, searched in order after the one above. Never written to, so a folder shared with colleagues stays safe. A name defined twice is taken from the first folder that has it."
        onSave={props.onSaveDirs}
      />

    </div>
  )
}
