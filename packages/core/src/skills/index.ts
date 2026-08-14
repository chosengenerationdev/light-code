import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Skills: durable notes the model can consult, written in markdown.
 *
 * The mechanism exists because some knowledge is worth keeping — which internal library to
 * use for what, how a team formats a commit, the shape of an in-house API — and repeating it
 * in every conversation is both tedious and unreliable.
 *
 * **Only `name` and `description` reach the system prompt.** Bodies are read on demand with
 * the ordinary `read_file` tool, so a skill costs a few tokens whether it is two lines or two
 * thousand, and it can reference other files and grow without bound. §13 is explicit that no
 * dedicated `load_skill` tool is needed; `read_file` already does the job.
 *
 * **A skill is a persistent prompt-injection vector** — prose that nobody code-reviews the way
 * they review code. Two things mitigate it: writes go through the approval gate showing the
 * full diff, and skills live in the workspace as plain markdown, so they land in git and get
 * read like any other document. Neither is airtight; the combination is what §13 asks for.
 */

export interface Skill {
  name: string
  description: string
  /** Absolute path, so the model can `read_file` it without guessing. */
  filePath: string
  /**
   * Which configured folder it came from.
   *
   * Needed because only the first folder is writable: the Skills tab uses this to say where
   * a skill lives and to refuse deleting one it does not own.
   */
  sourceDir?: string
}

export interface SkillLoadIssue {
  filePath: string
  detail: string
}

export interface LoadedSkills {
  skills: Skill[]
  /** Surfaced rather than swallowed: a skill silently absent is impossible to diagnose. */
  issues: SkillLoadIssue[]
}

/** Names a skill by its file, so a name is addressable and cannot escape the directory. */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

export function skillFileName(name: string): string {
  return `${name}.md`
}

/**
 * Reads YAML-ish frontmatter.
 *
 * Deliberately not a YAML parser. Only two scalar keys matter, and pulling in a parser to
 * read them would add a dependency, accept a great deal more syntax than intended, and give
 * a skill file more ways to be subtly wrong. Anything beyond `key: value` is ignored.
 */
export function parseFrontmatter(source: string): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source)
  if (match === null) return { body: source }

  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const entry = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (entry === null) continue
    // Quotes are stripped so `name: "thing"` and `name: thing` behave identically — the
    // difference is invisible in the UI and would otherwise change the skill's name.
    fields[entry[1] as string] = (entry[2] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  return {
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    body: match[2] ?? '',
  }
}

/** Builds the frontmatter block, so written skills are always in the shape the reader expects. */
export function renderSkill(name: string, description: string, body: string): string {
  // Description is single-lined: a newline inside it would break out of the frontmatter and
  // silently truncate the skill's metadata.
  const flattened = description.replace(/\s*\n\s*/g, ' ').trim()
  return `---\nname: ${name}\ndescription: ${flattened}\n---\n\n${body.trimStart()}`
}

async function loadOneDirectory(skillsDir: string): Promise<LoadedSkills> {
  const skills: Skill[] = []
  const issues: SkillLoadIssue[] = []

  let entries: string[]
  try {
    entries = (await fs.readdir(skillsDir)).filter((file) => file.endsWith('.md'))
  } catch {
    // A configured folder that does not exist yet is not an error — the workspace one is
    // absent until the first skill is written, and a shared folder may be on a drive that
    // is not mounted right now.
    return { skills, issues }
  }

  for (const file of entries.sort()) {
    const filePath = path.join(skillsDir, file)
    try {
      const parsed = parseFrontmatter(await fs.readFile(filePath, 'utf8'))
      const name = parsed.name ?? path.basename(file, '.md')
      if (parsed.description === undefined || parsed.description.length === 0) {
        // Without a description the model has nothing to decide on, so the skill would sit
        // in the prompt costing tokens and never being read.
        issues.push({ filePath, detail: 'No `description` in the frontmatter, so it was not offered.' })
        continue
      }
      skills.push({ name, description: parsed.description, filePath, sourceDir: skillsDir })
    } catch (error) {
      issues.push({ filePath, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  return { skills, issues }
}

/**
 * Loads skills from every configured folder, in order.
 *
 * ## Earlier folders win
 *
 * The list is a search path, like `PATH`. The first folder is the one skills are *written*
 * to, so a skill you wrote yourself overrides one of the same name from a shared team folder
 * — which is the direction people expect, and the only one that lets someone correct a
 * shared note locally without editing everyone's copy.
 *
 * A shadowed skill is reported as an issue rather than dropped silently. Two folders quietly
 * disagreeing about what `deployment` means is exactly the kind of thing that is impossible
 * to diagnose from the outside, and the Skills tab surfaces it.
 *
 * Duplicate paths are collapsed, since configuring the same folder twice — easy to do when
 * one entry is relative and another absolute — would otherwise make every skill in it shadow
 * itself and report a spurious conflict.
 */
export async function loadSkills(dirs: string | readonly string[]): Promise<LoadedSkills> {
  const ordered = (typeof dirs === 'string' ? [dirs] : dirs).map((dir) => path.resolve(dir))
  const unique = ordered.filter((dir, index) => ordered.indexOf(dir) === index)

  const skills: Skill[] = []
  const issues: SkillLoadIssue[] = []
  const claimed = new Map<string, Skill>()

  for (const dir of unique) {
    const loaded = await loadOneDirectory(dir)
    issues.push(...loaded.issues)

    for (const skill of loaded.skills) {
      const winner = claimed.get(skill.name)
      if (winner !== undefined) {
        issues.push({
          filePath: skill.filePath,
          detail: `Shadowed: "${skill.name}" is already defined by ${winner.filePath}, which takes precedence.`,
        })
        continue
      }
      claimed.set(skill.name, skill)
      skills.push(skill)
    }
  }

  // Sorted by name rather than by folder so the prompt block has a stable order regardless
  // of how the folders are arranged — the same cache reasoning as everything else at the
  // front of the prompt (§12).
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, issues }
}

/**
 * The block that goes into the system prompt.
 *
 * Names, descriptions and paths only. Kept stable within a session like everything else at
 * the front of the prompt — a skill created mid-session appears at the next turn, which is
 * the same rule Python tools follow and for the same cache reason (§12).
 */
export function renderSkillsForPrompt(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}\n  (${skill.filePath})`)
  return [
    '## Skills',
    '',
    'Notes recorded for this workspace. Only the summaries are here — when one looks relevant,',
    'read its file for the full content before acting on the subject.',
    '',
    ...lines,
  ].join('\n')
}
