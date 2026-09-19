import path from 'node:path'

/**
 * Reference files kept with a skill.
 *
 * Requested for the case a skill cannot carry in prose: *"some skills may need reference files,
 * like an excel template ... agent can use that template to fill some info and give the file back
 * to user"*. A template is not knowledge about how to do something — it is the thing the work is
 * done *with*, and there is nowhere else for it to live. Kept in the skill's own folder, so it
 * travels with the skill into git, into a shared folder, and into a colleague's checkout.
 *
 * ## Why this is not `images`
 *
 * A picture is *about* the skill: it is described in the body, indexed with it, and read by a
 * person. A reference file is *used by* the skill. That difference decides every rule here.
 *
 * ## Nothing here is indexed, and that is the point
 *
 * The skill's markdown is embedded and searched; these bytes never are. A `.xlsx` is a zip, and a
 * `.docx` and a `.pdf` likewise — feeding either to an embedder produces a vector for a compressed
 * archive, which is not wrong so much as meaningless, and it would sit in the corpus competing
 * with real answers. Worse, on a **team** alias (§12g) it would put a colleague's template
 * contents into a shared index nobody expected to hold file contents.
 *
 * So what is indexed is the *description* — a line of prose per file, written into the skill's
 * body where the existing machinery already finds it. The model learns a template exists and what
 * it is for; it gets the bytes only when it asks, by copying the file into the workspace.
 *
 * ## And that is why they are copied rather than read
 *
 * There is no tool here that returns file contents. A template is opened by Excel, filled in and
 * handed back — none of which wants the bytes in the transcript, and a 300KB workbook base64'd
 * into context would be both useless and expensive. `use_skill_file` puts a copy in the workspace
 * and returns the path; from there the ordinary tools apply.
 */

/** The folder reference files live in, inside the skill's own folder. */
export const SKILL_FILE_DIR = 'files'

/**
 * Bytes. Larger than the image cap because a workbook template legitimately is, and smaller than
 * "anything" because these are copied around, committed, and synced to a bucket. A dataset is a
 * dataset and belongs in one.
 */
export const MAX_SKILL_FILE_BYTES = 25 * 1024 * 1024

/** A skill is a page with its working materials, not a shared drive. */
export const MAX_SKILL_FILES = 12

export interface SkillFileInput {
  /** Where the file is now, relative to the workspace. */
  source: string
  /** What it is called inside the skill. Defaults to the source's own file name. */
  name?: string | undefined
  /**
   * What it is and when to use it. Required, unlike an image's description.
   *
   * This line is the *only* thing that reaches the index, so a file without one is a file the
   * model will never know to reach for — present on disk, absent in every way that matters.
   */
  description: string
}

export interface StoredSkillFile {
  name: string
  description: string
}

/**
 * The name a reference file gets inside the skill.
 *
 * Reduced to one safe segment, for the same reason as an image: the source is a path the model
 * chose, and a name carrying a separator would write outside the skill's folder.
 *
 * The extension is **kept as it is** rather than lowercased. Extensions are not what identifies a
 * file to a person here — the description is — and mangling one is how a `.XLSX` template stops
 * being recognised by something that matches on case.
 */
export function skillFileAssetName(input: SkillFileInput): string {
  const proposed = path.basename(input.name ?? input.source)
  const extension =
    path.extname(proposed) === '' ? path.extname(input.source) : path.extname(proposed)

  const withoutExtension =
    extension !== '' && proposed.toLowerCase().endsWith(extension.toLowerCase())
      ? proposed.slice(0, proposed.length - extension.length)
      : proposed

  const stem = withoutExtension
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${stem === '' ? 'file' : stem}${extension}`
}

/**
 * The markdown block listing a skill's reference files.
 *
 * Ordinary prose in the body, exactly like an image's description and for the same three reasons:
 * it is indexed by machinery that already exists, it is read by whoever opens the skill, and it is
 * what the model sees when the skill is loaded as text. A frontmatter field would do only the
 * last, and then only if something parsed it.
 *
 * The instruction to call `use_skill_file` is part of the block, not left to the tool description.
 * A model that has found the skill has found *this text*, and the next thing it needs to know is
 * how to get the file — putting that one line here is what stops it calling `read_file` on a
 * workbook and reporting that the template is corrupt.
 */
export function renderSkillFiles(skillName: string, files: readonly StoredSkillFile[]): string {
  if (files.length === 0) return ''
  return [
    '## Reference files',
    '',
    'Kept with this skill. Their contents are not in this text — call use_skill_file with skill',
    `"${skillName}" and the file name to copy one into the workspace, then work on the copy.`,
    '',
    ...files.map((file) => `- \`${file.name}\` — ${file.description.trim()}`),
  ].join('\n')
}

/**
 * Adds the list to a body that does not already have one.
 *
 * Matched on the heading rather than on each file name, unlike images: a file is referred to by
 * name in ordinary sentences ("fill in template.xlsx"), so name-matching would read a mention in
 * prose as a listing and silently drop the block that says how to obtain it.
 */
export function appendSkillFiles(
  body: string,
  skillName: string,
  files: readonly StoredSkillFile[],
): string {
  if (files.length === 0) return body
  if (/^##\s+Reference files\s*$/m.test(body)) return body
  return [body.replace(/\s+$/, ''), '', renderSkillFiles(skillName, files)].join('\n')
}

/**
 * Where a skill's reference files sit, or undefined when it has nowhere to keep them.
 *
 * Only the folder layout (`name/SKILL.md`) has somewhere; a flat `name.md` has no files by
 * definition, which is why writing one with files converts it to a folder.
 */
export function skillFilesDir(skillFilePath: string): string | undefined {
  const asPosix = skillFilePath.split(String.fromCharCode(92)).join('/')
  if (!asPosix.toLowerCase().endsWith('/skill.md')) return undefined
  return `${skillFilePath.slice(0, skillFilePath.length - 'SKILL.md'.length)}${SKILL_FILE_DIR}`
}

/**
 * The reference files a skill on disk actually has.
 *
 * Listed from the folder rather than parsed out of the markdown, for the reason `listSkillImages`
 * gives: what is on disk is the fact and the markdown is a description of it. Here the gap is
 * wider — a file can be added by dropping it in the folder, and a reference can outlive the file
 * it names — so the panel and the tool both read the folder.
 */
export async function listSkillFiles(
  skillFilePath: string,
  fs: { readdir: (dir: string) => Promise<{ name: string; isDirectory: boolean }[]> },
): Promise<string[]> {
  const dir = skillFilesDir(skillFilePath)
  if (dir === undefined) return []
  try {
    const entries = await fs.readdir(dir)
    return entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.name)
      .sort()
  } catch {
    // No folder is the ordinary case for a skill with no materials, not a failure to report.
    return []
  }
}
