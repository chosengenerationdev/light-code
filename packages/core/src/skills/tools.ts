import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { confine } from '../fs/confine.js'
import { describeTeamSkillCollision, type TeamSkillHit } from '../rag/teamSkills.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { isValidSkillName, parseFrontmatter, renderSkill, skillFileName } from './index.js'
import {
  appendSkillImages,
  skillImageName,
  skillImageType,
  MAX_SKILL_IMAGE_BYTES,
  SKILL_IMAGE_DIR,
  type SkillImageInput,
  type StoredSkillImage,
} from './images.js'
import { resolveToolPath } from '../tools/paths.js'
import type { ToolExecutionContext } from '../tools/types.js'

/**
 * Tools for recording and maintaining skills.
 *
 * The point is not that the model can write files — `write_to_file` already does that. It is
 * that a skill written this way is *structured*: the frontmatter is generated rather than
 * hand-typed, so a skill cannot end up unreadable because a description wrapped onto a second
 * line, and the model is told plainly when to reach for it.
 *
 * Approval-gated with a full diff, like every other write. A skill is prose the model injects
 * into its own future context, so the user seeing exactly what gets recorded is the whole
 * defence (§13).
 */

export interface SkillToolContext {
  skillsDir: string
  onChanged: () => Promise<void>
  /**
   * Submits the text for someone else to approve, instead of writing it.
   *
   * The same seam Python tools have and for a sharper reason: a skill is prose that steers every
   * future turn, and on a shared server it steers *everyone's*. One user recording something
   * wrong — or deliberate — would otherwise reach every colleague's next conversation.
   *
   * Absent in the extension, where the person approving is the person asking.
   */
  submitForReview?:
    | ((request: { name: string; content: string; existingContent: string }) => Promise<string>)
    | undefined
  /**
   * Looks a skill name up across the team's shared skills.
   *
   * Absent when no shared index is configured, which is the ordinary solo case — and the reason
   * this is a callback rather than a searcher: the tool has no business knowing a vector store
   * exists, and handing it one would put a corpus in reach of an edit tool.
   */
  findTeamSkillsNamed?: ((name: string) => Promise<TeamSkillHit[]>) | undefined
  /**
   * Publishes a skill that was just written, when skills are kept in a bucket.
   *
   * Absent unless an S3 folder is configured and writable, so writing works exactly as before for
   * everyone else. A failure here **does not fail the write**: the file is on disk and correct,
   * and losing it because a bucket was unreachable would be the worse outcome. The tool result
   * says the copy did not go up, so nothing is silently half-done.
   */
  onSaved?: ((name: string, content: string) => Promise<void>) | undefined
}

/** A skill is an illustrated page, not a gallery. */
const MAX_SKILL_IMAGES = 12

const writeParams = z.object({
  name: z
    .string()
    .describe('Short kebab-case identifier, e.g. "internal-http-client". Becomes the filename.'),
  description: z
    .string()
    .describe(
      'One line, and the only part loaded into every future conversation — so write it as the ' +
        'trigger for reading the skill: what subject it covers, not what it says.',
    ),
  body: z
    .string()
    .describe(
      'The markdown content. Be concrete: package names, import paths, function signatures, a ' +
        'short example. This is read only when relevant, so length costs nothing.',
    ),
  images: z
    .array(
      z.object({
        source: z
          .string()
          .min(1)
          .describe('The picture as it is now, relative to the workspace root.'),
        name: z
          .string()
          .optional()
          .describe('What to call it inside the skill. Defaults to the source file name.'),
        alt: z
          .string()
          .min(1)
          .describe('A few words saying what it is. Shown when the picture cannot be displayed.'),
        description: z
          .string()
          .optional()
          .describe(
            'What the picture shows, in enough words to find it by later. Written into the ' +
              'skill as ordinary text, so it is indexed with the rest and read by anyone who ' +
              'opens the skill - including a colleague whose copy cannot render images at all.',
          ),
      }),
    )
    .max(MAX_SKILL_IMAGES)
    .optional()
    .describe(
      'Pictures to keep with the skill: a diagram of a flow, a screenshot of a console nobody ' +
        'else can reach. Copied in beside it. Reference them in the body as ' +
        '`![alt](images/name.png)`, or leave them out of the body and they are listed at the end.',
    ),
})
export type WriteSkillParams = z.infer<typeof writeParams>

const deleteParams = z.object({ name: z.string().describe('The skill to remove.') })
export type DeleteSkillParams = z.infer<typeof deleteParams>

/**
 * Where a skill's text goes.
 *
 * `name.md` normally, and `name/SKILL.md` once it has pictures — which is the second layout §13
 * already reads, and the only one with somewhere to put them. A skill that is *already* a folder
 * stays one even when an update brings no new pictures, or the update would write a flat file
 * beside the folder and the folder's images would be orphaned behind a skill nobody loads.
 */
async function resolveSkillPath(
  skillsDir: string,
  name: string,
  wantsFolder = false,
): Promise<string> {
  if (!isValidSkillName(name)) {
    throw new Error(`"${name}" is not a valid skill name. Use lowercase letters, digits and hyphens.`)
  }
  // Created first: `confine` realpaths the root, which fails if it does not exist yet.
  await fs.mkdir(skillsDir, { recursive: true })

  const folder = await exists(path.join(skillsDir, name, 'SKILL.md'))
  if (wantsFolder || folder) {
    return confine(path.join(skillsDir, name, 'SKILL.md'), skillsDir)
  }
  return confine(path.join(skillsDir, skillFileName(name)), skillsDir)
}

/**
 * Copies the pictures in beside the skill.
 *
 * Every source goes through `resolveToolPath`, so the deny list and the workspace boundary apply
 * exactly as they do to `read_file` — the paths are model-chosen, and a skill is not a way around
 * the rules the reading tools follow. The destination name is reduced to one safe segment for the
 * same reason.
 */
async function copySkillImages(
  skillDir: string,
  images: readonly SkillImageInput[],
  context: ToolExecutionContext,
): Promise<StoredSkillImage[]> {
  if (images.length === 0) return []
  const target = await confine(path.join(skillDir, SKILL_IMAGE_DIR), skillDir)
  await fs.mkdir(target, { recursive: true })

  const stored: StoredSkillImage[] = []
  for (const image of images) {
    const name = skillImageName(image)
    const type = skillImageType(name)
    if (type === undefined) {
      throw new Error(`"${image.source}" is not an image a skill can hold (png, jpg, gif, webp, svg).`)
    }

    const source = await resolveToolPath(context, image.source)
    if (!source.ok) throw new Error(source.message)

    const bytes = await fs.readFile(source.realPath)
    if (bytes.length > MAX_SKILL_IMAGE_BYTES) {
      throw new Error(
        `"${image.source}" is ${String(Math.round(bytes.length / 1024))} KB. A skill holds ` +
          `illustrations, so the limit is ${String(MAX_SKILL_IMAGE_BYTES / 1024 / 1024)} MB each.`,
      )
    }

    await fs.writeFile(await confine(path.join(target, name), target), bytes)
    stored.push({
      name,
      alt: image.alt,
      ...(image.description !== undefined ? { description: image.description } : {}),
    })
  }
  return stored
}

/** What the pictures will be called, without needing the files to exist yet — used by `preview`. */
function plannedImages(params: { images?: SkillImageInput[] | undefined }): StoredSkillImage[] {
  return (params.images ?? []).map((image) => ({
    name: skillImageName(image),
    alt: image.alt,
    ...(image.description !== undefined ? { description: image.description } : {}),
  }))
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

export function createWriteSkillTool(context: SkillToolContext): Tool<WriteSkillParams> {
  /**
   * Whether a colleague already has a skill of this name.
   *
   * Never fatal. The shared index may be unbuilt, unreachable or simply not configured, and none
   * of those is a reason to stop someone recording what they just learned — the point of the
   * check is to *inform*, so failing to inform costs a sentence rather than the write.
   */
  const collisionWarning = async (name: string): Promise<string | undefined> => {
    if (context.findTeamSkillsNamed === undefined) return undefined
    try {
      return describeTeamSkillCollision(name, await context.findTeamSkillsNamed(name))
    } catch {
      return undefined
    }
  }

  return {
    name: 'write_skill',
    group: 'edit',
    description:
      'Record durable knowledge about this workspace so it survives into future conversations — ' +
      'internal libraries and how to use them, project conventions, in-house APIs, anything you ' +
      'were told once and would otherwise have to be told again. ' +
      'Creates or replaces the skill of that name; send the whole body, not a patch. ' +
      'Only the description is loaded into future prompts, so the cost of a long body is nothing. ' +
      'The user approves the exact text before it is written.',
    parametersSchema: writeParams,

    async preview(params): Promise<ToolPreview> {
      const filePath = await resolveSkillPath(context.skillsDir, params.name)
      return {
        kind: 'diff',
        path: filePath,
        before: await readIfPresent(filePath),
        // Rendered here, so the diff is exactly the bytes that get written rather than an
        // approximation of them.
        /*
         * Rendered with the image references in, because that is what the file will contain.
         * A preview showing the body without them would be approving different bytes - which
         * invariant 8 exists to prevent, and the pictures are the part somebody would look for.
         */
        after: renderSkill(
          params.name,
          params.description,
          appendSkillImages(params.body, plannedImages(params)),
        ),
      }
    },

    async execute(params, toolContext): Promise<ToolResult> {
      try {
        const wantsFolder = (params.images ?? []).length > 0
        const filePath = await resolveSkillPath(context.skillsDir, params.name, wantsFolder)
        const before = await readIfPresent(filePath)
        const existed = before.length > 0

        /*
         * Copied before the text is written, so a picture that cannot be read fails the whole
         * write rather than leaving a skill referencing an image that is not there — a broken
         * link in a document somebody will read later and be unable to explain.
         */
        const stored =
          wantsFolder && context.submitForReview === undefined
            ? await copySkillImages(path.dirname(filePath), params.images ?? [], toolContext)
            : plannedImages(params)
        const rendered = renderSkill(
          params.name,
          params.description,
          appendSkillImages(params.body, stored),
        )

        // Before the write, not after: a skill that existed even briefly is one that could be
        // read into a turn, and "briefly" is not a security property.
        if (context.submitForReview !== undefined) {
          return {
            content: await context.submitForReview({
              name: params.name,
              content: rendered,
              existingContent: before,
            }),
          }
        }

        await fs.writeFile(filePath, rendered, 'utf8')

        /*
         * A skill that has just become a folder leaves its flat file behind otherwise.
         *
         * Both would load, under the same name, and the search path would silently pick one —
         * so an update with pictures would appear to have done nothing. Removed only when the
         * folder write succeeded, so a failure cannot lose the original.
         */
        if (wantsFolder) {
          const flat = path.join(context.skillsDir, skillFileName(params.name))
          if (await exists(flat)) await fs.rm(flat).catch(() => undefined)
        }

        await context.onChanged()

        // Reported, never thrown: see `onSaved`. The local file is already written and valid.
        let publishProblem: string | undefined
        if (context.onSaved !== undefined) {
          try {
            await context.onSaved(params.name, rendered)
          } catch (error) {
            publishProblem = error instanceof Error ? error.message : String(error)
          }
        }

        /*
         * Reported *after* the write, deliberately.
         *
         * The user asked to be told about a collision, not to be stopped by one — and a team
         * where nobody may name a skill somebody else already named would be worse than one with
         * two skills called `deployment`. Yours is stored under your own name and theirs is
         * untouched, so there is nothing to undo; what is left is a choice, and the model is
         * told to put it to the user rather than make it.
         */
        const collision = existed ? undefined : await collisionWarning(params.name)

        return {
          content:
            `${existed ? 'Updated' : 'Recorded'} the skill "${params.name}" at ${filePath}.\n` +
            // Same rule as Python tools, same reason: the prompt prefix is fixed for a turn.
            'Its summary will appear in your context from the next message onward.' +
            (publishProblem === undefined
              ? ''
              : `\n\nSaved here, but NOT copied to the bucket: ${publishProblem}`) +
            (collision === undefined ? '' : `\n\n${collision}`),
          path: filePath,
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

export function createDeleteSkillTool(context: SkillToolContext): Tool<DeleteSkillParams> {
  return {
    name: 'delete_skill',
    group: 'edit',
    description: 'Remove a recorded skill.',
    parametersSchema: deleteParams,

    async preview(params): Promise<ToolPreview> {
      const filePath = await resolveSkillPath(context.skillsDir, params.name)
      // A diff to nothing, so the user sees what is being discarded rather than just a name.
      return { kind: 'diff', path: filePath, before: await readIfPresent(filePath), after: '' }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const filePath = await resolveSkillPath(context.skillsDir, params.name)
        await fs.rm(filePath, { force: true })
        await context.onChanged()
        return { content: `Removed the skill "${params.name}".`, path: filePath }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

/** Reads a skill back, so the model can revise one accurately rather than from memory. */
export function readSkillBody(source: string): string {
  return parseFrontmatter(source).body
}
