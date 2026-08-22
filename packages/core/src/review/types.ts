/**
 * Work a non-administrator wrote that must be reviewed before it can run.
 *
 * ## Why staging rather than a blocking prompt
 *
 * The approval gate assumes someone is present, which is true in a chat and false on a shared
 * server where the person who may approve is not the person asking. Blocking the turn until an
 * administrator answers would hang for hours when nobody is at a screen, and forever for a
 * scheduled run. So the turn is told the work was submitted and carries on.
 *
 * ## What "staged" has to mean
 *
 * Not registered, not loadable, not callable. §13 makes the *registry* the security boundary
 * rather than the prompt — a `.py` with no registry entry never loads — so staging is exactly
 * that boundary used deliberately: the file is held outside the tools directory until an
 * administrator has seen the source and approved it. Nothing about the hash pinning changes; the
 * hash is simply recorded later, and by someone else.
 */
export type ReviewKind = 'python-tool' | 'skill'

export interface ReviewRequest {
  id: string
  kind: ReviewKind
  /** The tool or skill name, which is what it will be called if approved. */
  name: string
  /** Exactly what will be written. What the administrator reads is what runs. */
  content: string
  /** The file as it is now, when this replaces something. Empty for a new one. */
  existingContent: string
  /** Who asked. A directory id, so it survives a rename. */
  authorId: string
  authorName: string
  submittedAt: number
  /** Set when a programming provider wrote the source rather than the chat model. */
  producedBy?: string
}

export interface ReviewDecision {
  id: string
  approved: boolean
  /** Shown to the author. A rejection with no reason is a rejection they cannot act on. */
  reason?: string
  decidedBy: string
  decidedAt: number
}

/**
 * What the author is told, immediately, in the turn that submitted it.
 *
 * Phrased so the model does not treat it as a failure and retry — a retry produces a second
 * identical request in the queue and an administrator with two things to read. It is also
 * explicit that the tool is not callable yet, because the model's next instinct is to use it.
 */
export function describeSubmission(request: Pick<ReviewRequest, 'kind' | 'name'>): string {
  const what = request.kind === 'python-tool' ? 'tool' : 'skill'
  return [
    `Submitted "${request.name}" for review. It is not saved and not callable yet.`,
    '',
    `An administrator has to read the ${what} and approve it before it can run. This is not an`,
    'error and there is nothing to retry — submitting again would only add a second copy to the',
    'queue. Tell the user it is waiting for approval and carry on with whatever else the task',
    'needs.',
  ].join('\n')
}
