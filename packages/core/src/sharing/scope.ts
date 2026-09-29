/**
 * Which project's — and optionally whose — skills and tools a search returns.
 *
 * Asked for because one bucket and one cluster serve several teams: by default the assistant should
 * find what belongs to *this* project, and on request go wider, or look at one named project, or
 * one person's work. `search_docs` and `search_team_skills` both use this, so "this project" means
 * the same thing to both.
 *
 * ## The default includes anything unlabelled
 *
 * Built-in and MCP tools belong to no project, and skills written before labels existed carry
 * none. Leaving them out by default would hide tools the assistant needs and every older skill, so
 * the default is "this project, or no project said". Naming a project or an author asks for exact
 * matches, and unlabelled skills and Python tools are left out then — except a tool that *cannot*
 * carry a label (anything not `py__`), which is never somebody else's.
 *
 * ## "This project" is two names
 *
 * The configured project name and the folder name. A skill labelled with the folder name before a
 * project name was set is still this project's, and dropping it would look like the skill vanishing
 * the moment the name was saved.
 */

export interface SearchScope {
  /** Undefined means every project. Compared case-insensitively. */
  projects?: string[] | undefined
  /** Whether an item with no project label counts as in scope. */
  includeUnlabelled: boolean
  /** Only this author's, compared case-insensitively. */
  author?: string | undefined
}

/** What the model may pass for `project` to mean every project. */
const EVERY_PROJECT = new Set(['all', '*', 'any', 'every'])

/** The default a user chose in Settings -> Project, for requests that name no project or author. */
export interface DefaultSearchScope {
  mode: 'project' | 'author' | 'all'
  /** This machine's author, for the `author` mode. */
  author?: string | undefined
}

export function resolveSearchScope(
  requested: { project?: string | undefined; author?: string | undefined },
  currentProject: readonly string[],
  fallback?: DefaultSearchScope,
): SearchScope {
  const author = requested.author?.trim()
  const withAuthor = author !== undefined && author.length > 0 ? { author } : {}
  const project = requested.project?.trim()
  const saidNothing = (project === undefined || project.length === 0) && author === undefined
  if (saidNothing && fallback !== undefined) {
    if (fallback.mode === 'all') return { includeUnlabelled: true }
    // Only yours, in any project. Tools that can carry no label stay, as always.
    if (fallback.mode === 'author' && fallback.author !== undefined) return { includeUnlabelled: true, author: fallback.author }
  }
  if (project !== undefined && project.length > 0) {
    if (EVERY_PROJECT.has(project.toLowerCase())) return { includeUnlabelled: true, ...withAuthor }
    return { projects: [project], includeUnlabelled: false, ...withAuthor }
  }
  const names = [...new Set(currentProject.map((name) => name.trim()).filter((name) => name.length > 0))]
  return names.length > 0 ? { projects: names, includeUnlabelled: true, ...withAuthor } : { includeUnlabelled: true, ...withAuthor }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Whether an item is in scope. `labelable` is false for things that can never carry a label —
 * built-in and MCP tools — which are always in scope, since they are nobody's.
 */
export function inSearchScope(
  label: { project?: string | undefined; author?: string | undefined },
  scope: SearchScope,
  labelable = true,
): boolean {
  if (!labelable) return true
  if (scope.projects !== undefined) {
    if (label.project === undefined) {
      if (!scope.includeUnlabelled) return false
    } else if (!scope.projects.some((name) => same(name, label.project as string))) {
      return false
    }
  }
  if (scope.author !== undefined) {
    if (label.author === undefined || !same(label.author, scope.author)) return false
  }
  return true
}

/** One phrase for a result header: what was searched. */
export function describeSearchScope(scope: SearchScope): string {
  const project =
    scope.projects === undefined
      ? 'every project'
      : `project ${scope.projects[0] ?? ''}${scope.includeUnlabelled ? ' (and anything with no project)' : ''}`
  return scope.author !== undefined ? `${project}, by ${scope.author}` : project
}

/** What the model is told when something was left out, so it knows how to go wider. */
export function describeHidden(count: number, scope: SearchScope): string {
  if (count === 0) return ''
  const wider = scope.author !== undefined ? 'leave out `author`, or pass project: "all"' : 'pass project: "all"'
  return `${String(count)} match(es) from outside ${describeSearchScope(scope)} were left out — ${wider} to include them.`
}
