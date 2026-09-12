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

/** More than any real plan, and few enough that the panel stays a list rather than a document. */
export const MAX_CHECKPOINTS = 50

export type CheckpointStatus = 'todo' | 'active' | 'done'

export interface Checkpoint {
  /** Stable across reordering, and changes when the step's wording does. See above. */
  id: string
  /** 1-based, and the number the model is given to refer to. */
  index: number
  text: string
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

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/

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
  const marked = lines
    .map((line) => LIST_ITEM.exec(line)?.[1]?.trim())
    .filter((text): text is string => text !== undefined && text.length > 0)

  const texts = (
    marked.length > 0 ? marked : lines.map((line) => line.trim()).filter((line) => line.length > 0)
  ).slice(0, MAX_CHECKPOINTS)

  /*
   * Two steps with the same wording are two steps, so ids are disambiguated by occurrence.
   * Without this they collide and marking the second done also marks the first.
   */
  const seen = new Map<string, number>()
  return texts.map((text, position) => {
    const key = normalise(text)
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    return {
      id: occurrence === 1 ? idFor(key) : `${idFor(key)}-${String(occurrence)}`,
      index: position + 1,
      text,
    }
  })
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
