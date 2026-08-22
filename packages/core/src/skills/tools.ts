import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { confine } from '../fs/confine.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { isValidSkillName, parseFrontmatter, renderSkill, skillFileName } from './index.js'

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
}

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
})
export type WriteSkillParams = z.infer<typeof writeParams>

const deleteParams = z.object({ name: z.string().describe('The skill to remove.') })
export type DeleteSkillParams = z.infer<typeof deleteParams>

async function resolveSkillPath(skillsDir: string, name: string): Promise<string> {
  if (!isValidSkillName(name)) {
    throw new Error(`"${name}" is not a valid skill name. Use lowercase letters, digits and hyphens.`)
  }
  // Created first: `confine` realpaths the root, which fails if it does not exist yet.
  await fs.mkdir(skillsDir, { recursive: true })
  return confine(path.join(skillsDir, skillFileName(name)), skillsDir)
}

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

export function createWriteSkillTool(context: SkillToolContext): Tool<WriteSkillParams> {
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
        after: renderSkill(params.name, params.description, params.body),
      }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const filePath = await resolveSkillPath(context.skillsDir, params.name)
        const before = await readIfPresent(filePath)
        const existed = before.length > 0
        const rendered = renderSkill(params.name, params.description, params.body)

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
        await context.onChanged()
        return {
          content:
            `${existed ? 'Updated' : 'Recorded'} the skill "${params.name}" at ${filePath}.\n` +
            // Same rule as Python tools, same reason: the prompt prefix is fixed for a turn.
            'Its summary will appear in your context from the next message onward.',
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
