/**
 * How a branch name is shown under a chat's name: in full when it fits, otherwise trimmed in the middle of
 * its description - never through a leading Jira key, because \`PAY-1234\` is the part people look for.
 * The full name goes in the tooltip. Fire Code's shell.js has the same rule in plain JavaScript;
 * \`branchLabel.test.ts\` holds both to the same cases.
 */
export function branchLabel(branch: string, max = 28): string {
  if (branch.length <= max) return branch
  const jira = /^([A-Za-z][A-Za-z0-9]+-\d+)([-_/].*)?$/.exec(branch)
  if (jira?.[1] !== undefined) {
    const key = jira[1]
    const rest = (jira[2] ?? '').replace(/^[-_/]/, '')
    const room = Math.max(max - key.length - 2, 4)
    return rest.length === 0 ? key : `${key} ${rest.length > room ? `${rest.slice(0, room - 1)}…` : rest}`
  }
  return `${branch.slice(0, max - 1)}…`
}
