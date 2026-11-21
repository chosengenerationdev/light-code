import path from 'node:path'
import { mentionSegment } from './mentionGlob.js'
import { compareMentionCandidates, matchesMentionQuery } from './mentionRanking.js'

/** A host's file index, as `HostServices.findFiles`. */
export type MentionIndex = (
  segment: string,
  limit: number,
  excludeFolders: readonly string[],
  /** `folders`: folders (not files) whose name contains the segment. */
  mode?: 'contains' | 'prefix' | 'folders',
  depth?: number,
  root?: string,
) => Promise<string[]>

/** Folders asked for per keystroke; the ranking keeps the best of them. */
const FOLDER_SCAN_LIMIT = 300
/** How many of the best-matching folders have their files listed too. */
const FOLDERS_OPENED = 2
/** Files listed from inside each of those. */
const FILES_PER_FOLDER = 40

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
 *
 * **Folder names count** (reported: "it is not considering directory names"). A file index matches
 * file names, so `@reports` never found anything kept in a `reports/` folder whose files are named
 * otherwise. Folders whose name contains the text are asked for separately and offered as
 * `folder/` (choosing one keeps the picker open inside it), and the files of the best one or two
 * are listed too. Typing a path - `src/abc/` or `src/abc/rep` - searches inside that folder first.
 */
export async function searchMentions(
  find: MentionIndex,
  workspaceRoot: string,
  query: string,
  excludeFolders: readonly string[],
  scanLimit: number,
  resultLimit: number,
  /** Search another folder (a sibling codebase) instead of the workspace. */
  otherRoot?: string,
): Promise<string[]> {
  const segment = mentionSegment(query)
  const base = otherRoot ?? workspaceRoot
  const relative = (absolute: string): string => path.relative(workspaceRoot, absolute).split(path.sep).join('/')

  // `src/abc/rep`: inside `src/abc` when that folder exists, which an answer from it proves.
  const typedFolder = folderPart(query)
  if (typedFolder !== undefined) {
    const inside = path.resolve(base, typedFolder)
    const within = path.relative(base, inside)
    if (within.length > 0 && !within.startsWith('..') && !path.isAbsolute(within)) {
      const [files, folders] = await Promise.all([
        find(segment, scanLimit, excludeFolders, undefined, undefined, inside).catch(() => []),
        find(segment, FOLDER_SCAN_LIMIT, excludeFolders, 'folders', undefined, inside).catch(() => []),
      ])
      if (files.length > 0 || folders.length > 0) {
        const insideQuery = `${typedFolder.replace(/\\/g, '/').replace(/\/+$/, '')}/${segment}`
        return rank(
          [...folders.map((f) => `${relative(f)}/`), ...files.map(relative)],
          insideQuery,
          resultLimit,
        )
      }
    }
  }

  let found = await find(segment, scanLimit, excludeFolders, undefined, undefined, otherRoot)
  if (found.length >= scanLimit && segment.length > 0) {
    const leading: string[] = []
    for (let depth = 0; depth <= 12 && leading.length < resultLimit; depth++) {
      leading.push(...(await find(segment, scanLimit, excludeFolders, 'prefix', depth, otherRoot)))
    }
    found = [...new Set([...leading, ...found])]
  }
  const files = found.map(relative)

  if (segment.length === 0) return rank(files, query, resultLimit)

  // Folders whose name matches, from the index and from the paths already found.
  const needle = segment.toLowerCase()
  const folderList = await find(segment, FOLDER_SCAN_LIMIT, excludeFolders, 'folders', undefined, otherRoot).catch(() => [])
  const folders = new Set(folderList.map((f) => `${relative(f)}/`))
  for (const file of files) {
    const parts = file.split('/')
    for (let i = 0; i < parts.length - 1; i++) {
      if ((parts[i] ?? '').toLowerCase().includes(needle)) folders.add(`${parts.slice(0, i + 1).join('/')}/`)
    }
  }
  // The files of the best one or two folders, so `@reports` lists what is in `reports/`.
  const best = [...folders].filter(matchesMentionQuery(query)).sort(compareMentionCandidates(query)).slice(0, FOLDERS_OPENED)
  const opened = await Promise.all(
    best.map((folder) =>
      find('', FILES_PER_FOLDER, excludeFolders, undefined, undefined, path.join(workspaceRoot, folder)).catch(() => []),
    ),
  )
  return rank([...folders, ...files, ...opened.flat().map(relative)], query, resultLimit)
}

function rank(candidates: string[], query: string, limit: number): string[] {
  return [...new Set(candidates)]
    .filter((c) => c !== '/' && !c.startsWith('../'))
    .filter(matchesMentionQuery(query))
    .sort(compareMentionCandidates(query))
    .slice(0, limit)
}

/** The folder part of a query - `src/abc` from `src/abc/rep` or `src/abc/` - or none. */
function folderPart(query: string): string | undefined {
  const trimmed = query.trim()
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (separator <= 0) return undefined
  return trimmed.slice(0, separator)
}
