/**
 * Ordering for the `@` file picker.
 *
 * ## Why ranking exists at all
 *
 * The picker shows a couple of dozen entries, and a workspace has thousands of files. Whatever
 * decides which ones are shown *is* the feature — get it wrong and the answer is "it does not
 * find my files", which is what happened when the file index's own limit did the choosing.
 *
 * ## The order, and the reasoning behind each rule
 *
 * Someone typing `@auth` is almost always after a file *named* something like auth, not one of
 * forty files sitting in a folder called `auth`. So a filename match outranks a path match, and
 * a filename that *starts* with the query outranks one that merely contains it. After that,
 * shallower and shorter wins: a match near the root of the repository is more likely the one
 * meant than something buried in generated output.
 */

/** Entries are workspace-relative and `/`-separated, as the picker sends them. */
export function compareMentionCandidates(query: string): (a: string, b: string) => number {
  const needle = query.trim().toLowerCase()
  return (a, b) => {
    const rankDiff = rank(a, needle) - rank(b, needle)
    if (rankDiff !== 0) return rankDiff

    // Shallower first: `src/api.ts` before `packages/x/src/deep/api.ts`.
    const depthDiff = depthOf(a) - depthOf(b)
    if (depthDiff !== 0) return depthDiff

    const lengthDiff = a.length - b.length
    if (lengthDiff !== 0) return lengthDiff
    // Alphabetical last, so the list is stable rather than dependent on index order.
    return a.localeCompare(b)
  }
}

function fileNameOf(candidate: string): string {
  const slash = candidate.lastIndexOf('/')
  return slash < 0 ? candidate : candidate.slice(slash + 1)
}

function depthOf(candidate: string): number {
  let depth = 0
  for (const character of candidate) if (character === '/') depth += 1
  return depth
}

/** Lower is better. An empty query ranks everything equally and leaves it to depth and length. */
function rank(candidate: string, needle: string): number {
  if (needle.length === 0) return 0
  const name = fileNameOf(candidate).toLowerCase()
  if (name === needle) return 0
  // A base name match — `api` finding `api.ts` — is what someone typing a name usually means.
  if (name.slice(0, name.lastIndexOf('.') < 0 ? name.length : name.lastIndexOf('.')) === needle) return 1
  if (name.startsWith(needle)) return 2
  if (name.includes(needle)) return 3
  return 4
}

/**
 * Whether a candidate is worth showing for a query at all.
 *
 * The file index is asked only about the last path segment, because `*` does not cross a
 * separator and the obvious whole-query glob matches nothing. So a query like `src/api` needs
 * filtering here, against the full relative path.
 *
 * Matching is **subsequence, not substring**. Someone typing `mrank` should find
 * `mentionRanking.ts`, and someone typing `srcapi` should find `src/api.ts` — people type the
 * letters they remember, in order, and skip the rest. Ordering then decides which of the matches
 * is worth being first; this only decides what is plausible at all.
 */
export function matchesMentionQuery(query: string): (candidate: string) => boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return () => true

  // Separators are ignored on both sides, so `src/api`, `srcapi` and `src api` behave alike.
  const wanted = needle.replace(/[/\\ ]/g, '')
  return (candidate) => isSubsequence(wanted, candidate.toLowerCase().replace(/[/\\]/g, ''))
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true
  let index = 0
  for (const character of haystack) {
    if (character === needle[index]) {
      index += 1
      if (index === needle.length) return true
    }
  }
  return false
}
