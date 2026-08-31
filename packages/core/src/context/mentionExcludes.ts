/**
 * Folders the `@` file picker leaves out.
 *
 * ## Why this exists at all
 *
 * `vscode.workspace.findFiles(include, exclude)` does not *add* to the editor's own excludes — a
 * non-null `exclude` **replaces** `files.exclude` and `search.exclude` entirely. So passing
 * a `node_modules` exclude pattern to keep `node_modules` out quietly switched off every other exclusion the
 * user had configured, which is how a virtualenv ended up in the picker: thousands of files in
 * front of the twenty someone was looking for.
 *
 * These are folder names matched at any depth, not globs, because that is what people want to type
 * and it cannot go wrong the way a hand-written glob can.
 *
 * **Not a security control.** Confinement and the path deny list decide what may be *read*; this
 * only decides what is offered while typing. A user may still mention any path they can name.
 */
export const DEFAULT_MENTION_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  // Python environments, which is the case that prompted this — `.venv` is conventional, `venv`
  // and `env` are common enough to be worth having, and `__pycache__` is pure noise.
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  // Build output: generated, usually large, and never the file someone means.
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  // Tool caches.
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.gradle',
  '.idea',
]

/**
 * The folder list to apply: the user's when they have set one, the defaults otherwise.
 *
 * An empty array is honoured rather than treated as unset — someone who genuinely wants to reach
 * into `.venv` has said so, and silently overriding that would be the picker deciding it knows
 * better.
 */
export function mentionExcludes(configured: readonly string[] | undefined): readonly string[] {
  if (configured === undefined) return DEFAULT_MENTION_EXCLUDES
  return configured.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/**
 * The list as one VS Code exclude glob, or undefined when there is nothing to exclude.
 *
 * Undefined matters: passing it to `findFiles` restores the editor's own `files.exclude` handling,
 * which is the correct behaviour when the user has cleared the list.
 */
export function mentionExcludeGlob(folders: readonly string[]): string | undefined {
  if (folders.length === 0) return undefined
  // A brace list rather than one pattern per call: `findFiles` takes a single exclude.
  return `**/{${folders.join(',')}}/**`
}
