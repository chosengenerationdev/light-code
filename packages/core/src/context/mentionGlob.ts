/**
 * The file-index pattern for what somebody has typed after `@`.
 *
 * ## The bug this exists to fix
 *
 * The picker built its pattern by interpolating the query straight into `` `**\/*…*` ``, and that
 * is wrong in two ways that both present identically, as "it does not find my files".
 *
 * **It was case-sensitive.** VS Code's `findFiles` is ripgrep underneath, and ripgrep globs match
 * case exactly. Measured on this machine against a real `rg.exe`: `**\/*app*` returns **nothing**
 * for a file called `App.tsx`, while `**\/*App*` returns it. People type lowercase, and a
 * TypeScript or Python repository is largely PascalCase and CamelCase filenames, so the picker was
 * silently blind to a large share of the codebase. Every other part of the feature had already
 * decided this question the other way — `compareMentionCandidates` and `matchesMentionQuery` both
 * lowercase both sides, and the Node host's own walk does `toLowerCase().includes(...)`. The glob
 * was the one place that disagreed, which is why it looked like the *search* was broken rather
 * than the pattern.
 *
 * **It passed the user's keystrokes to a glob parser unescaped.** `[`, `]`, `{`, `}`, `?` and `*`
 * are glob syntax, so typing `@data[1].csv` produced a pattern matching a *character class* and
 * therefore nothing at all — the picker went empty exactly when somebody was being most specific.
 * Measured the same way: unescaped `**\/*data[1]*` matches nothing, `**\/*data\[1\]*` matches the
 * file.
 *
 * ## Why a character class rather than a case-insensitive flag
 *
 * `vscode.workspace.findFiles` takes a glob string and nothing else — there is no flag to pass. A
 * class per letter is the only expression of case-insensitivity the pattern language has, and it
 * is what ripgrep's own glob compiler understands. Verified against the shipped `rg.exe` rather
 * than assumed, because this is precisely the kind of claim that reads as obviously true and is
 * not.
 *
 * ## What this deliberately does not do
 *
 * It does not widen matching beyond the last path segment, and it does not try to rank. The glob
 * decides *what is plausible*; `matchesMentionQuery` and `compareMentionCandidates` decide what is
 * shown and in what order, and those are comparisons in code where they can be tested. Splitting
 * it any other way puts judgement into a pattern language.
 */

/** Glob syntax that must survive as a literal when somebody types it into the picker. */
const GLOB_METACHARACTERS = new Set(['\\', '*', '?', '[', ']', '{', '}', '!'])

/**
 * One character as a glob fragment matching it in either case.
 *
 * A letter becomes a two-member class; anything else is passed through, escaped when the glob
 * parser would otherwise read it as syntax. Non-ASCII letters are left alone: `[àÀ]` is correct
 * for some alphabets and wrong for others, and the file index already matches them literally.
 */
function caseInsensitive(character: string): string {
  const lower = character.toLowerCase()
  const upper = character.toUpperCase()
  if (lower !== upper && /^[a-z]$/.test(lower)) return `[${lower}${upper}]`
  return GLOB_METACHARACTERS.has(character) ? `\\${character}` : character
}

/**
 * The pattern to ask the file index for, given the last segment of what was typed.
 *
 * An empty segment means "everything", which is what someone who has typed `@` or `@src/` wants:
 * the ranking then decides which of it to show.
 */
export function mentionGlob(segment: string): string {
  if (segment.length === 0) return '**/*'
  const body = [...segment].map(caseInsensitive).join('')
  return `**/*${body}*`
}

/**
 * The last path segment of a mention query — the part a glob can match.
 *
 * `*` does not cross a separator, so the whole query is never a usable pattern. Owned here beside
 * `mentionGlob` because the two are one decision: which part of the query the index is asked
 * about, and how it is spelled.
 */
export function mentionSegment(query: string): string {
  const trimmed = query.trim()
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}
