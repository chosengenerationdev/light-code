import type { ToolGroup } from '../tools/types.js'

/**
 * A DevOps connection the user has only read access to (Confluence, Jira, Bitbucket, Jenkins, AutoSys).
 *
 * Asked for with AutoSys: "i am getting readonly access ... provide a way to hint that this is readonly
 * access so that it wont even try to do some change actions". Two parts, and both matter:
 *
 * - **Every tool that changes something is left out**, not merely described as unavailable. A tool
 *   the model can see is a tool it will try, and the server would answer with a 403 after the user had
 *   already been asked to approve the change - an approval for something that could never happen.
 *   The split is by group, which every DevOps tool already declares honestly: `read` stays, `edit`
 *   and `command` (write a page, force-start a job, start a build, merge) go.
 * - **The read tools say so**, so a request to change something is answered with what to ask a person
 *   with access to do - rather than the model hunting for another route to the same change, such as
 *   running the product's own command-line client through the shell.
 */

export function readOnlyNote(label: string): string {
  return (
    ` Access to ${label} here is read-only: nothing in ${label} can be changed from this chat. If asked to ` +
    'change something, say so and give the exact change for someone with access to make; do not try another way.'
  )
}

/** The tools to register for a product: all of them, or only the readers, marked as such. */
export function toolsForAccess<T extends { group: ToolGroup; description: string }>(
  tools: readonly T[],
  readOnly: boolean,
  label: string,
): T[] {
  if (!readOnly) return [...tools]
  const note = readOnlyNote(label)
  return tools.filter((tool) => tool.group === 'read').map((tool) => ({ ...tool, description: tool.description + note }))
}
