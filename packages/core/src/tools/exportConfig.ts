import path from 'node:path'

import { z } from 'zod'

import type { LightCodeConfig } from '../config/schema.js'
import {
  buildExport,
  defaultSelection,
  describeSections,
  SHARE_SECTIONS,
  type ShareSectionId,
} from '../config/share.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolPreview, ToolResult } from './types.js'

/**
 * Writes this machine's shareable Light Code setup to a file in the workspace.
 *
 * Asked for so the assistant can prepare a team onboarding page with a JSON colleagues import —
 * the same file Settings → Export writes, produced by the same `buildExport`, so the two can never
 * disagree about what is shared. That function builds the export by *copying in* chosen sections,
 * which is what keeps secrets, approvals, per-project settings and identity out of it by
 * construction rather than by a list somebody has to remember (§15).
 *
 * `edit` group: it writes a file. The approval shows the literal JSON and names every credential
 * an importer will have to enter — the file is going to be handed to other people, and what is in
 * it is exactly the thing to read before it goes.
 */

const sectionIds = SHARE_SECTIONS.map((section) => section.id) as [ShareSectionId, ...ShareSectionId[]]

const paramsSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Where to write it in the workspace, e.g. "onboarding/light-code-team.json".'),
  sections: z
    .array(z.enum(sectionIds))
    .optional()
    .describe(
      'Which parts of the setup to include. Omit for the usual team set (providers, MCP servers, ' +
        'search, skills, tools, buckets and similar). Never includes secrets or approvals.',
    ),
})
export type ExportConfigParams = z.infer<typeof paramsSchema>

export interface ExportConfigToolOptions {
  loadConfig: () => Promise<LightCodeConfig>
}

function prepare(config: LightCodeConfig, params: ExportConfigParams): { json: string; notes: string } {
  const chosen = params.sections ?? defaultSelection(config)
  const exported = buildExport(config, chosen)
  const summaries = describeSections(config).filter((summary) => chosen.includes(summary.id))
  const credentials = summaries.flatMap((summary) => summary.secretRefs)
  const included = summaries.filter((summary) => summary.present).map((summary) => `${summary.label} (${summary.detail})`)
  const notes = [
    `Sections: ${included.length > 0 ? included.join(', ') : 'none with anything in them'}.`,
    credentials.length > 0
      ? `Whoever imports it must enter: ${credentials.join('; ')}.`
      : 'No credentials to enter after importing.',
    'Secrets, approvals, per-project settings and identity are never included.',
  ].join(' ')
  return { json: `${JSON.stringify(exported, null, 2)}\n`, notes }
}

export function createExportConfigTool(options: ExportConfigToolOptions): Tool<ExportConfigParams> {
  return {
    name: 'light_code_export_config',
    group: 'edit',
    description:
      "Write this machine's shareable Light Code setup to a JSON file in the workspace — the same " +
      'file Settings → Export produces — for a colleague to import with Settings → Import. Use it ' +
      'when preparing onboarding material. Contains no secrets; the result lists the credentials ' +
      'each importer must enter themselves.',
    parametersSchema: paramsSchema,

    async preview(params, context): Promise<ToolPreview> {
      const { json, notes } = prepare(await options.loadConfig(), params)
      let before = ''
      const resolved = await resolveToolPath(context, params.path, { write: true })
      if (resolved.ok) {
        before = await context.fs.readFile(resolved.realPath).catch(() => '')
      }
      return { kind: 'diff', path: params.path, before, after: json, note: notes }
    },

    async execute(params, context): Promise<ToolResult> {
      const resolved = await resolveToolPath(context, params.path, { write: true })
      if (!resolved.ok) return { content: resolved.message, isError: true }
      const { json, notes } = prepare(await options.loadConfig(), params)
      // A folder like `onboarding/` that does not exist yet is the ordinary case, as for write_to_file.
      await context.fs.mkdir(path.dirname(resolved.realPath))
      await context.fs.writeFile(resolved.realPath, json)
      return { content: `Wrote ${params.path}. ${notes}`, path: resolved.realPath }
    },
  }
}
