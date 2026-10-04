import path from 'node:path'
import { mentionSegment } from './mentionGlob.js'
import { compareMentionCandidates, matchesMentionQuery } from './mentionRanking.js'

/** A host's file index, as `HostServices.findFiles`. */
export type MentionIndex = (
  segment: string,
  limit: number,
  excludeFolders: readonly string[],
  mode?: 'contains' | 'prefix',
  depth?: number,
) => Promise<string[]>

/**
 * The `@` picker's candidates: fetched widely, then ranked, then cut.
 *
 * **A capped scan is a sample, not a ranking.** Reported from real use: `@abc` in a codebase with
 * thousands of job scripts showed only `jobs/bat/…`, because the index handed back its first two
 * thousand matches - all scripts - before reaching `src/abc/abc_report.py`. The cap chose, and the
 * ranking never saw the file.
 *
 * So when the scan is full, the names that *start* with the text are fetched again, **one folder
 * depth at a time, shallowest first**, until there are enough to fill the list. That is the order the
 * ranking itself uses (a name starting with the text, then the shallower path), so the top of the
 * list is exact however many files match, and no cap can push the right one out. It costs a few
 * more index calls, and only on the keystrokes where the first scan overflowed.
 */
export async function searchMentions(
  find: MentionIndex,
  workspaceRoot: string,
  query: string,
  excludeFolders: readonly string[],
  scanLimit: number,
  resultLimit: number,
): Promise<string[]> {
  const segment = mentionSegment(query)
  let found = await find(segment, scanLimit, excludeFolders)
  if (found.length >= scanLimit && segment.length > 0) {
    const leading: string[] = []
    for (let depth = 0; depth <= 12 && leading.length < resultLimit; depth++) {
      leading.push(...(await find(segment, scanLimit, excludeFolders, 'prefix', depth)))
    }
    found = [...new Set([...leading, ...found])]
  }
  return found
    .map((absolute) => path.relative(workspaceRoot, absolute).split(path.sep).join('/'))
    .filter(matchesMentionQuery(query))
    .sort(compareMentionCandidates(query))
    .slice(0, resultLimit)
}
