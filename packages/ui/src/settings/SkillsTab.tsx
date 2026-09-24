import { formatAliases, parseAliases, type ProbeTarget } from '@light-code/core/browser'
import { IndexProbe } from './IndexProbe.js'
import { IndexingProgress, type IndexingProgressState } from './IndexingProgress.js'
import { useEffect, useState, type ReactElement } from 'react'
import { badgeStyle, colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { FolderListEditor } from './FolderListEditor.js'
import { MigrateFolder, type MigrateFolderProps } from './MigrateFolder.js'
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

/** Copying skills in from a folder that used to hold them. See `MigrateFolder`. */
export type SkillsTabMigrate = Omit<MigrateFolderProps, 'kind'>

export interface SkillsTabProps {
  s3?: SkillsTabS3 | undefined
  /** Copying skills in from a folder that used to hold them. */
  migrate?: SkillsTabMigrate | undefined
  skills: {
    name: string
    description: string
    filePath: string
    /** File names of the pictures kept with it. The bytes are fetched only when one is opened. */
    images?: string[]
    /**
     * Reference files kept with it — a template to fill in, a config to start from.
     *
     * Listed, never fetched. There is nothing useful to show of a workbook in a settings panel,
     * and unlike a picture these are measured in megabytes. Somebody who wants to touch one opens
     * the skill and works in the folder beside it.
     */
    files?: string[]
    sourceDir?: string
    always?: boolean
    /**
     * Set when the skill came from a bucket mirror.
     *
     * The local copy is a cache the sync will replace, so removing it here would achieve nothing;
     * the bucket is the only place it can go. `canDelete` is false for a read-only connection,
     * with `reason` said out loud rather than the button quietly doing nothing.
     */
    bucket?: { label: string; canDelete: boolean; reason?: string }
  }[]
  /**
   * Pictures already fetched, keyed `skill/image`.
   *
   * Held by the caller rather than here so they survive this tab being unmounted and remounted —
   * reopening Settings would otherwise re-fetch every picture somebody had already looked at.
   */
  skillImages?: Record<string, { dataUri?: string; problem?: string }> | undefined
  onRequestSkillImage?: ((skill: string, image: string) => void) | undefined
  issues: { filePath: string; detail: string }[]
  /** Where new skills are written. Undefined when no folder is open. */
  skillsDir?: string | undefined
  /** Read-only folders searched after `skillsDir`. */
  extraDirs: string[]
  /** The configured value rather than the resolved one, so the field round-trips what was typed. */
  configuredDir: string
  onDelete: (name: string) => void
  /**
   * Asks what removing a bucket skill would delete. Lists; changes nothing.
   *
   * Two steps because this is the one delete here that reaches other people: the confirmation
   * shows the literal objects rather than a count, and what runs is what was on screen.
   */
  onPreviewBucketDelete?: ((name: string, sourceDir: string) => void) | undefined
  onDeleteFromBucket?: ((name: string, sourceDir: string, keys: string[]) => void) | undefined
  /** The plan that came back, while a confirmation is open. */
  bucketDeletePlan?:
    | { name: string; sourceDir: string; label: string; keys: string[]; error?: string }
    | undefined
  onCancelBucketDelete?: (() => void) | undefined
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
    /**
     * The collection this machine publishes into, resolved.
     *
     * Shown because everyone publishes to their **own** and the alias spans them — so the one
     * thing somebody needs when attaching an alias by hand, or matching what they see in the
     * cluster against what Light Code writes, is this name. It was computed in four places and
     * displayed in none.
     */
    collection?: string
    onSaveAliases: (aliases: string[]) => void
    onPublish: () => void
    onClear: () => void
    onStop: () => void
    publishing?: boolean
    progress: IndexingProgressState | undefined
    result: { count?: number; collection?: string; cleared?: number; error?: string } | undefined
    /**
     * Which of *this machine's own* skills currently have a matching document in the
     * collection — undefined until asked for, so a stale answer is never shown as current.
     */
    status?: { name: string; indexed: boolean }[] | undefined
    statusError?: string | undefined
    statusLoading?: boolean | undefined
    onRefreshStatus: () => void
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

      {/*
        Your own collection, named.

        The section already says "everyone publishes to their own collection" and then never said
        which — so attaching an alias by hand, or matching what is in the cluster against what
        Light Code writes, meant guessing. Read-only: it is derived from the owner and the
        workspace, and `embedder.indexName` is where it is changed.
      */}
      {props.collection !== undefined && (
        <div style={{ marginBottom: 10, fontSize: 11, color: colors.muted }}>
          This machine publishes into{' '}
          <code style={{ fontFamily: monospace, color: colors.foreground }}>{props.collection}</code>
        </div>
      )}

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

      {/*
        A live check against the collection, not a memory of the last publish — a skill sent a
        minute ago and edited since should not still read as "indexed". Same reasoning §12e gives
        for checking locality against the filesystem rather than trusting a stored label.

        Scoped to skills authored on this machine: one brought in from a bucket is a copy, and
        "indexed" is a question about your own publishing of it, not about the copy itself.
      */}
      <div style={{ marginTop: 14, borderTop: `1px solid ${colors.border}`, paddingTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 12 }}>Your skills in the index</strong>
          <button
            type="button"
            style={secondaryButtonStyle()}
            disabled={aliases.length === 0 || props.statusLoading === true}
            onClick={props.onRefreshStatus}
          >
            {props.statusLoading === true ? 'Checking…' : 'Check status'}
          </button>
        </div>
        {props.statusError !== undefined && (
          <span style={{ display: 'block', color: colors.error, fontSize: 11 }}>{props.statusError}</span>
        )}
        {props.statusError === undefined &&
          props.status !== undefined &&
          (props.status.length === 0 ? (
            <p style={{ color: colors.muted, fontSize: 11, margin: 0 }}>
              Nothing authored on this machine yet — skills brought in from a bucket are not
              counted here.
            </p>
          ) : (
            <div>
              {props.status.map((entry) => (
                <div
                  key={entry.name}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}
                >
                  {/*
                    Colour is never the only signal — the word beside it carries the same fact,
                    for anyone who cannot tell the dots apart.
                  */}
                  <span
                    aria-hidden
                    title={entry.indexed ? 'Indexed' : 'Not indexed'}
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: entry.indexed ? colors.accent : colors.error,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontFamily: monospace, fontSize: 12 }}>{entry.name}</span>
                  <span style={{ color: colors.muted, fontSize: 11 }}>
                    {entry.indexed ? 'indexed' : 'not indexed'}
                  </span>
                </div>
              ))}
            </div>
          ))}
      </div>
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

      {/*
        Moved up here from underneath the whole skill list, where it was findable only by
        someone who scrolled past every skill first to reach it — the same reasoning that put
        the Reindex row at the top of this file.
      */}
      {props.s3 !== undefined && <S3Section {...props.s3} kind="skills" manageConnections />}
      {props.migrate !== undefined && <MigrateFolder {...props.migrate} kind="skills" />}

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
                  ) : skill.bucket !== undefined ? (
                    /*
                      A bucket skill is read-only *on disk* and deletable in the bucket, which is
                      not the same thing — and saying only "read-only" is what left somebody with
                      no way to remove a skill at all. The reason is shown when it genuinely
                      cannot be deleted, so the absence of a button is explained rather than
                      merely observed.
                    */
                    skill.bucket.canDelete && props.onPreviewBucketDelete !== undefined ? (
                      <button
                        type="button"
                        style={secondaryButtonStyle()}
                        title={`Delete this skill from ${skill.bucket.label}, for everyone`}
                        onClick={() =>
                          props.onPreviewBucketDelete?.(skill.name, skill.sourceDir ?? '')
                        }
                      >
                        Delete from bucket
                      </button>
                    ) : (
                      <span style={{ color: colors.muted, fontSize: 10 }}>
                        {skill.bucket.reason ?? 'read-only'}
                      </span>
                    )
                  ) : (
                    <span style={{ color: colors.muted, fontSize: 10 }}>read-only</span>
                  )}
                </span>
              </div>
              <div style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{skill.description}</div>
              <div style={{ color: colors.muted, fontSize: 10, fontFamily: monospace, marginTop: 2 }}>
                {skill.filePath}
              </div>

              {/*
                The pictures, shown on demand.

                Names arrive with the skill and the bytes do not, so opening one is a request.
                That keeps the common case — a list of skills nobody is inspecting — free, and
                it is the same reason the diagram is a `data:` URI rather than a served file:
                the webview's policy allows that and nothing else.
              */}
              {(skill.images ?? []).length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(skill.images ?? []).map((image) => {
                    const key = `${skill.name}/${image}`
                    const loaded = props.skillImages?.[key]
                    return (
                      <div key={key}>
                        {loaded?.dataUri === undefined ? (
                          <button
                            type="button"
                            style={secondaryButtonStyle()}
                            onClick={() => props.onRequestSkillImage?.(skill.name, image)}
                          >
                            {loaded?.problem === undefined ? `Show ${image}` : `Retry ${image}`}
                          </button>
                        ) : (
                          <figure style={{ margin: 0 }}>
                            <img
                              src={loaded.dataUri}
                              alt={image}
                              /* Bounded, because a screenshot is often far wider than this panel. */
                              style={{
                                maxWidth: '100%',
                                borderRadius: 4,
                                border: `1px solid ${colors.border}`,
                                display: 'block',
                              }}
                            />
                            <figcaption
                              style={{ color: colors.muted, fontSize: 11, marginTop: 2, fontFamily: monospace }}
                            >
                              {image}
                            </figcaption>
                          </figure>
                        )}
                        {loaded?.problem !== undefined && (
                          <div style={{ color: colors.error, fontSize: 11 }}>{loaded.problem}</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/*
                Reference files: named, with no way to open one from here.

                Deliberate — see the prop. The point of listing them is that a skill carrying a
                template should not look identical to one that does not, which is the whole
                difference between "why does it not know about the form" and "there it is".
              */}
              {(skill.files ?? []).length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: colors.muted }}>
                  <span>Reference files: </span>
                  <span style={{ fontFamily: monospace }}>{(skill.files ?? []).join(', ')}</span>
                </div>
              )}

              {/*
                The bucket confirmation, showing the literal objects.

                Invariant 8 applied to a delete: a count is a description of what is about to
                happen, and the keys are the thing itself. It also says who else this reaches,
                because that is the part that makes this different from removing a local file -
                somebody reading "Delete?" has no way to know a colleague loses it too.
              */}
              {props.bucketDeletePlan?.name === skill.name && (
                <div
                  style={{
                    marginTop: 6,
                    padding: 8,
                    border: `1px solid ${colors.error}`,
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  {props.bucketDeletePlan.error !== undefined ? (
                    <>
                      <div style={{ color: colors.error }}>{props.bucketDeletePlan.error}</div>
                      <button
                        type="button"
                        style={{ ...secondaryButtonStyle(), marginTop: 6 }}
                        onClick={() => props.onCancelBucketDelete?.()}
                      >
                        Close
                      </button>
                    </>
                  ) : props.bucketDeletePlan.keys.length === 0 ? (
                    <>
                      {/* A real answer, not a failure: somebody may already have removed it. */}
                      <div>
                        Nothing for &quot;{skill.name}&quot; is in {props.bucketDeletePlan.label} any
                        more. The local copy will go when you close this.
                      </div>
                      <button
                        type="button"
                        style={{ ...secondaryButtonStyle(), marginTop: 6 }}
                        onClick={() => props.onCancelBucketDelete?.()}
                      >
                        Close
                      </button>
                    </>
                  ) : (
                    <>
                      <div style={{ fontWeight: 600 }}>
                        Delete {props.bucketDeletePlan.keys.length} object(s) from{' '}
                        {props.bucketDeletePlan.label}?
                      </div>
                      <div style={{ color: colors.muted, marginTop: 2 }}>
                        This removes it from the bucket for everyone who syncs it, and it cannot be
                        undone from here. Your local copy goes too.
                      </div>
                      <ul
                        style={{
                          margin: '6px 0 0 0',
                          padding: '0 0 0 16px',
                          fontFamily: monospace,
                          fontSize: 11,
                          maxHeight: 160,
                          overflowY: 'auto',
                        }}
                      >
                        {props.bucketDeletePlan.keys.map((key) => (
                          <li key={key}>{key}</li>
                        ))}
                      </ul>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button
                          type="button"
                          style={{ ...primaryButtonStyle(false), background: colors.error }}
                          onClick={() => {
                            // The keys that were shown, not a fresh listing - so what runs is what
                            // was on screen. See `s3/remove.ts`.
                            props.onDeleteFromBucket?.(
                              skill.name,
                              props.bucketDeletePlan?.sourceDir ?? '',
                              props.bucketDeletePlan?.keys ?? [],
                            )
                            props.onCancelBucketDelete?.()
                          }}
                        >
                          Delete from bucket
                        </button>
                        <button
                          type="button"
                          style={secondaryButtonStyle()}
                          onClick={() => props.onCancelBucketDelete?.()}
                        >
                          Keep
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

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
    </div>
  )
}
