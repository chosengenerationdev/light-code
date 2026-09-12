/**
 * The plan, read as a list of checkpoints, and what has happened to each.
 *
 * ## Why the plan stays one string
 *
 * The obvious design is a structured plan — an array of steps the user edits in a list. It was
 * not taken, because the plan is *also* the text that goes into the system prompt, and a
 * structured plan would mean the prose sent to the model and the steps shown in the panel are two
 * representations of one fact. They drift, and this project has paid for that shape more than any
 * other (see CLAUDE.md). So the string is the truth and the checkpoints are **derived from it**,
 * every time, by this file. Editing the plan text is the only way to change the steps, and the
 * panel cannot disagree with the prompt because it is reading the same words.
 *
 * ## Why ids are content-derived rather than positional
 *
 * Progress has to survive the user editing their plan, which they do mid-task — that is the whole
 * point of being able to modify it. With positional ids, inserting a step at the top silently
 * moves "done" onto the wrong work, and the panel then reports completed things that were never
 * done. With content ids, reordering keeps every step's progress, and *rewording* a step clears
 * only that step. That is the honest reading: a step whose text changed is not obviously the step
 * that was finished, and claiming otherwise is the failure mode worth avoiding.
 */

import { AGENT_ROLES } from '../agents/roles.js'

/** More than any real plan, and few enough that the panel stays a list rather than a document. */
export const MAX_CHECKPOINTS = 50

export type CheckpointStatus = 'todo' | 'active' | 'done'

export interface Checkpoint {
  /** Stable across reordering, and changes when the step's wording does. See above. */
  id: string
  /** 1-based, and the number the model is given to refer to. */
  index: number
  text: string
  /**
   * Specialists the plan says should be involved in this step.
   *
   * A statement of intent from the approved plan — **not** evidence that anybody was consulted.
   * `CheckpointView.roles` is that, and the two are kept apart deliberately; see
   * `rolesMentionedIn`.
   */
  plannedRoles: string[]
}

/** What happened to one checkpoint. Keyed by checkpoint id in `PlanProgress`. */
export interface CheckpointProgress {
  status: Exclude<CheckpointStatus, 'todo'>
  /**
   * Specialists that actually answered while this checkpoint was the active one.
   *
   * **Never what the model said the roles were.** The assistant declares which checkpoint it is
   * on; who contributed is observed from consultations that really happened, because a claim
   * about who did the work is exactly the kind of thing nobody thinks to go and check.
   */
  roles: string[]
  /** When it last changed, so the panel can say "done" rather than only show it. */
  at: number
}

export type PlanProgress = Record<string, CheckpointProgress>

/** A checkpoint with its progress resolved — what the panel renders and the protocol carries. */
export interface CheckpointView extends Checkpoint {
  status: CheckpointStatus
  roles: string[]
}

/**
 * One list item: its indentation, whether it is numbered, and its text.
 *
 * Indentation and ordered-ness both matter, because a real plan is not a flat list — see
 * `parseCheckpoints` for the two things that went wrong when this only matched "a line starting
 * with a bullet or a number".
 */
const LIST_ITEM = /^(\s*)(?:([-*•])|(\d+)[.)])\s+(.+)$/

interface ListLine {
  indent: number
  ordered: boolean
  text: string
  line: number
}

/**
 * A short, stable id for a step's text.
 *
 * FNV-1a rather than a real digest: this needs to be deterministic and identical wherever it
 * runs, not unforgeable. Nothing is authorised by it.
 */
function idFor(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** Wording differences that are not step differences: spacing, case, trailing punctuation. */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.;,:]+$/, '')
}

/**
 * The steps in a plan.
 *
 * List markers win where the plan has any, so a plan with a sentence of preamble above its steps
 * does not turn that sentence into step one. A plan written as bare lines still gets checkpoints,
 * because plenty of people write one that way and a progress view that only worked for
 * bullet-point authors would read as broken.
 */
export function parseCheckpoints(plan: string | undefined): Checkpoint[] {
  const lines = (plan ?? '').split(/\r?\n/)

  const items: ListLine[] = []
  lines.forEach((line, index) => {
    const match = LIST_ITEM.exec(line)
    if (match === null) return
    const text = match[4]?.trim() ?? ''
    if (text.length === 0) return
    items.push({
      indent: (match[1] ?? '').replace(/\t/g, '    ').length,
      ordered: match[3] !== undefined,
      text,
      line: index,
    })
  })

  /*
   * Which items are the *steps*, out of everything that looks like a list.
   *
   * Reported with a real plan: six numbered steps, one of which had five sub-bullets describing
   * an architecture, followed by "Definition of done" and "Notes" sections that were also bullet
   * lists. The old rule — any line starting with a bullet or a number — turned that into
   * seventeen checkpoints. The panel became a jumble, and far worse, **the numbering contract
   * broke**: the assistant was told step 5 was "ONE callback writes the store" while the plan the
   * user approved said step 5 was "Review". `plan_progress` then moves the wrong row.
   *
   * Two rules fix it, in order:
   *
   * 1. **Numbered items win outright.** Somebody who numbered their steps has said which things
   *    are steps; every bullet in the document is then either a sub-point or a trailing section,
   *    and neither is a step. This is what excludes "Definition of done" and "Notes".
   * 2. **Only the shallowest level counts.** Sub-points are indented under their parent, so
   *    taking the minimum indentation keeps the parent and drops its detail. It also handles a
   *    plan written entirely in bullets, which is common enough to matter.
   */
  const ordered = items.filter((item) => item.ordered)
  const candidates = ordered.length > 0 ? ordered : items
  const shallowest = candidates.reduce(
    (least, item) => Math.min(least, item.indent),
    Number.POSITIVE_INFINITY,
  )
  const steps = candidates.filter((item) => item.indent === shallowest)

  const texts =
    steps.length > 0
      ? steps
      : // No list at all: plenty of people write a plan as bare lines, and a progress view that
        // only worked for bullet-point authors would read as broken.
        lines
          .map((line, index) => ({ indent: 0, ordered: false, text: line.trim(), line: index }))
          .filter((item) => item.text.length > 0)

  const chosen = texts.slice(0, MAX_CHECKPOINTS)

  /*
   * Two steps with the same wording are two steps, so ids are disambiguated by occurrence.
   * Without this they collide and marking the second done also marks the first.
   */
  const seen = new Map<string, number>()
  return chosen.map((item, position) => {
    const key = normalise(item.text)
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    const until = chosen[position + 1]?.line ?? lines.length
    return {
      id: occurrence === 1 ? idFor(key) : `${idFor(key)}-${String(occurrence)}`,
      index: position + 1,
      text: item.text,
      /*
       * Who the plan says should be involved, read from the step *and everything under it* —
       * which is where the allocation actually lives, since a specialist is usually named on a
       * continuation line ("Owner: reviewer") or inside a sub-point rather than in the heading.
       */
      plannedRoles: rolesMentionedIn(lines.slice(item.line, until).join(' ')),
    }
  })
}

/**
 * Roles the plan names for a step.
 *
 * ## Why this is scanned rather than required in a fixed format
 *
 * The plan is prose a model wrote and a person approved, and it will say "Owner: reviewer.",
 * "Specialist: **expert**", or "hand it to the tester" on different days. Demanding one syntax
 * would mean the panel showing nothing whenever the wording drifted, which is indistinguishable
 * from the feature being broken. Matching the role words themselves is robust to all of it.
 *
 * ## Why a planned role is not the same claim as a role chip
 *
 * An observed chip says *this specialist actually answered while that step was open* — ground
 * truth, recorded host-side. This says only *the approved plan intends to consult them*. The two
 * must stay visually distinct, because the whole value of the observed one is that it cannot be
 * asserted by anybody. They are separate fields for that reason, never merged.
 *
 * "none" is handled by simply not being a role: "Specialist: none needed" matches nothing.
 */
function rolesMentionedIn(text: string): string[] {
  const haystack = text.toLowerCase()
  return AGENT_ROLES.filter((role) => new RegExp(`\\b${role}\\b`).test(haystack))
}

/**
 * The plan's steps with their progress attached.
 *
 * Progress for an id the plan no longer contains is **not** carried over — it is dropped by being
 * unreachable from here. A step that was edited away is not a step, and reporting it as done
 * would be the panel claiming something about work that is no longer in the plan.
 */
export function checkpointViews(
  plan: string | undefined,
  progress: PlanProgress | undefined,
): CheckpointView[] {
  return parseCheckpoints(plan).map((checkpoint) => {
    const recorded = progress?.[checkpoint.id]
    return {
      ...checkpoint,
      status: recorded?.status ?? 'todo',
      roles: recorded?.roles ?? [],
    }
  })
}

/**
 * Progress with entries for steps the plan no longer has removed.
 *
 * Called when the plan changes, so what is *stored* matches what is shown rather than
 * accumulating claims about deleted work for ever.
 */
export function pruneProgress(
  plan: string | undefined,
  progress: PlanProgress | undefined,
): PlanProgress {
  if (progress === undefined) return {}
  const live = new Set(parseCheckpoints(plan).map((checkpoint) => checkpoint.id))
  const kept: PlanProgress = {}
  for (const [id, entry] of Object.entries(progress)) if (live.has(id)) kept[id] = entry
  return kept
}

/** Marks one step, by the number the model was given. Returns undefined when there is no such step. */
export function markCheckpoint(
  plan: string | undefined,
  progress: PlanProgress,
  index: number,
  status: Exclude<CheckpointStatus, 'todo'>,
): PlanProgress | undefined {
  const checkpoint = parseCheckpoints(plan).find((candidate) => candidate.index === index)
  if (checkpoint === undefined) return undefined

  const existing = progress[checkpoint.id]
  return {
    ...progress,
    [checkpoint.id]: {
      status,
      // Kept across a start→done transition: the specialists consulted while the step was being
      // worked are exactly the ones that contributed to finishing it.
      roles: existing?.roles ?? [],
      at: Date.now(),
    },
  }
}

/**
 * Records that a specialist answered while a step was active.
 *
 * Attributed to whatever is `active`, because that is the step the assistant said it was on when
 * the consultation happened. Nothing is attributed when no step is active — a guess about which
 * step a consultation belonged to is worth less than an honest blank.
 */
export function attributeConsultation(progress: PlanProgress, role: string): PlanProgress {
  const entry = Object.entries(progress).find(([, value]) => value.status === 'active')
  if (entry === undefined) return progress

  const [id, value] = entry
  if (value.roles.includes(role)) return progress
  return { ...progress, [id]: { ...value, roles: [...value.roles, role] } }
}

/** One line for the composer's collapsed row: how far through the plan this chat is. */
export function progressSummary(views: CheckpointView[]): string {
  const done = views.filter((view) => view.status === 'done').length
  return `${String(done)}/${String(views.length)}`
}
