import { formatAliases, parseAliases, type ProbeTarget } from '@light-code/core/browser'
import { IndexProbe } from './IndexProbe.js'
import { IndexingProgress, type IndexingProgressState } from './IndexingProgress.js'
import { useEffect, useState, type ReactElement } from 'react'
import { badgeStyle, colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { FolderListEditor } from './FolderListEditor.js'
import { S3Section, type S3SectionProps } from './S3Section.js'
import { DismissableProblems } from './DismissableProblems.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

/**
 * The S3 half, passed straight through to `S3Section`.
 *
 * The connection list lives here because pointing skill storage at a bucket is what people come to
 * this tab to do — and it is shared: the Python tab picks from the same list rather than keeping
 * its own, since one bucket edited in two places is the drift this project has paid for most.
 */
export type SkillsTabS3 = Omit<S3SectionProps, 'kind' | 'manageConnections'>

export interface SkillsTabProps {
  s3?: SkillsTabS3 | undefined
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
  onClearIndex: () => void
  probe: { running: boolean; result: { query: string; text: string; error?: string } | undefined }
  onProbe: (query: string, target: ProbeTarget) => void
  onClearProbe: () => void
  /** The bar for the skills reindex, which is the one this button starts. */
  indexProgress: IndexingProgressState | undefined
  onStopIndexing: () => void
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
    /**
     * Every name the pool answers to, most specific first.
     *
     * A list because one collection can be a squad's and the whole department's at once, and each
     * is a level of sharing. The first is what a search defaults to, so the order is an answer and
     * is kept as typed rather than sorted.
     */
    aliases?: string[]
    onSaveAliases: (aliases: string[]) => void
    onPublish: () => void
    onClear: () => void
    onStop: () => void
    publishing?: boolean
    progress: IndexingProgressState | undefined
    result: { count?: number; collection?: string; cleared?: number; error?: string } | undefined
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
  /*
   * Read once, with an absent list meaning none.
   *
   * A fresh install has no aliases at all, and that is the state `SettingsNavigation.test.tsx`
   * renders every tab in — the path this component has to survive before anybody has configured
   * anything. Derived here so no later line has to remember.
   */
  const aliases = props.aliases ?? []
  const saved = formatAliases(aliases)
  const [alias, setAlias] = useState(saved)
  const [confirmingClear, setConfirmingClear] = useState(false)
  useEffect(() => setAlias(saved), [saved])
  // Compared as parsed lists, so re-typing the same names in a different spacing is not an edit.
  const unsaved = formatAliases(parseAliases(alias)) !== saved

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
        Shared skills aliases <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
      </label>
      <input
        id="lc-skills-alias"
        type="text"
        value={alias}
        spellCheck={false}
        placeholder="e.g. my-team-skills, platform-skills"
        onChange={(event) => setAlias(event.target.value)}
        style={textFieldStyle()}
      />
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
        Separate several with commas, most specific first &mdash; a squad, a department, everyone.
        The first is the one a search uses when it is not told which. Up to 8.
      </span>

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
          disabled={!unsaved}
          onClick={() => props.onSaveAliases(parseAliases(alias))}
        >
          {unsaved ? '1. Save these names' : '1. Names saved'}
        </button>
        <button
          type="button"
          style={primaryButtonStyle(aliases.length === 0)}
          disabled={aliases.length === 0 || props.publishing === true}
          title={aliases.length === 0 ? 'Save the name first' : 'Embeds your skills and writes them to the shared collection'}
          onClick={props.onPublish}
        >
          {props.publishing === true ? 'Sending…' : '2. Send my skills to the team'}
        </button>
      </div>

      {/*
        Taking it back is as much a part of publishing as sending it, and there was no way to.

        Confirmed inline rather than done on the first click: this is the one control here that
        removes something other people can see.
      */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {confirmingClear ? (
          <>
            <span style={{ fontSize: 11 }}>Remove every skill you have published?</span>
            <button
              type="button"
              style={primaryButtonStyle(false)}
              onClick={() => {
                setConfirmingClear(false)
                props.onClear()
              }}
            >
              Remove them
            </button>
            <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirmingClear(false)}>
              Keep them
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              style={secondaryButtonStyle()}
              disabled={aliases.length === 0 || props.publishing === true}
              onClick={() => setConfirmingClear(true)}
            >
              Remove mine from the pool
            </button>
            <span style={{ color: colors.muted, fontSize: 11 }}>
              Only your own copies. Colleagues publish to their own collections, so this cannot
              reach theirs.
            </span>
          </>
        )}
      </div>

      <IndexingProgress progress={props.progress} onStop={props.onStop} />

      {props.result?.error !== undefined && (
        <span style={{ display: 'block', color: colors.error, fontSize: 11, marginTop: 6 }}>
          {props.result.error}
        </span>
      )}
      {props.result?.error === undefined && props.result?.cleared !== undefined && (
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 6 }}>
          {`Removed ${String(props.result.cleared)} published skill(s).`}
        </span>
      )}
      {props.result?.error === undefined &&
        props.result?.cleared === undefined &&
        props.result?.count !== undefined && (
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
      {/*
        At the top, because it is an action rather than a setting.

        It sat under the folder editors, below every skill in the list, so on a workspace with a
        dozen skills it was off the bottom of the panel entirely - present, and findable only by
        someone who already knew it was there.
      */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" style={secondaryButtonStyle()} disabled={props.indexing} onClick={props.onReindex}>
          {props.indexing ? 'Reindexing…' : 'Reindex skills'}
        </button>
        {/* Scoped to skills: the collection is shared with tool documentation. */}
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={props.indexing}
          title="Removes skill entries from the documentation index. Tools are left alone."
          onClick={props.onClearIndex}
        >
          Clear skill entries
        </button>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          {props.indexResult ??
            'Reindexed automatically a few seconds after any change. This forces it now, for skills only.'}
        </span>
      </div>
      <IndexingProgress progress={props.indexProgress} onStop={props.onStopIndexing} />

      {/*
        Here as well as in Search, because this is where you are when you wonder whether a skill
        you just wrote can actually be found.
      */}
      <IndexProbe
        target="docs"
        label="Search indexed tools and skills"
        hint="Runs the same lookup the assistant uses to find a skill. Covers tool documentation too - they share one index."
        running={props.probe.running}
        result={props.probe.result}
        onProbe={props.onProbe}
        onClear={props.onClearProbe}
      />

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

      {/*
        Below the folder list, because it is one more place skills come from — and the section
        itself says the mirrored folder joins that list rather than replacing it.
      */}
      {props.s3 !== undefined && <S3Section {...props.s3} kind="skills" manageConnections />}
    </div>
  )
}
