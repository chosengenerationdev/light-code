import path from 'node:path'

import { z } from 'zod'

import { layoutDiagram } from '../diagrams/layout.js'
import { DEFAULT_PALETTE, diagramSvg } from '../diagrams/svg.js'
import { diagramSpecSchema } from '../diagrams/types.js'
import { resolveToolPath } from '../tools/paths.js'
import type { Tool, ToolExecutionContext, ToolPreview, ToolResult } from '../tools/types.js'
import { contentTypeFor, isSafeAttachmentName, type ConfluenceClient } from './client.js'

/**
 * Searching, reading and writing Confluence pages.
 *
 * ## Three tools, not seven
 *
 * Search, read, and write — where write creates a page or updates one depending on whether it is
 * given a page id, and carries its attachments with it. §17 prefers fewer, more general tools, and
 * "create", "update" and "attach" as separate tools would be three descriptions differing by a word
 * for what a person experiences as one act: *put this page up*.
 *
 * ## What the approval shows (invariant 8)
 *
 * Writing is `edit`, and in `ALWAYS_ASK_TOOLS`: it publishes under the user's name to people who
 * will read it as theirs, and there is no undo this product owns. The preview is computed, never
 * relayed — for an update, the page's **current** body is fetched and diffed against the new one;
 * for a new page, the whole body is shown as new. Every attachment is listed with the file it
 * comes from and its size, and every diagram with its node count, because a picture uploaded
 * alongside a page is part of what is being published.
 *
 * ## Diagrams
 *
 * Rendered by the same `layoutDiagram` + `diagramSvg` pair `show_diagram` uses, with the fixed
 * light palette rather than the editor's theme — the page is read by people in a browser, not in
 * this editor. Every label is escaped by `diagramSvg`, so a diagram cannot carry markup.
 */

export interface ConfluenceToolOptions {
  /** Built per call, so a rotated token or changed site applies to the next request. */
  client: () => Promise<ConfluenceClient>
  /** Space key used when a new page names none. */
  defaultSpace?: string | undefined
}

/** At most this many pictures per read, each no larger than this: providers cap both. */
const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 3_500_000

const STORAGE_GUIDE =
  'Body is Confluence storage format (XHTML): <h1>-<h3>, <p>, <ul>/<ol>/<li>, <table><tbody><tr><th>/<td>, ' +
  '<strong>, <code>, <a href="...">. Every tag must be closed. Useful macros: ' +
  '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>…</p></ac:rich-text-body></ac:structured-macro> ' +
  '(also "note", "tip", "warning"); ' +
  '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter>' +
  '<ac:plain-text-body><![CDATA[…]]></ac:plain-text-body></ac:structured-macro>; ' +
  '<ac:structured-macro ac:name="toc"/>; ' +
  '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">…</ac:parameter><ac:rich-text-body>…</ac:rich-text-body></ac:structured-macro>. ' +
  'Show an attached image or diagram with <ac:image ac:width="800"><ri:attachment ri:filename="NAME"/></ac:image>; ' +
  'link a downloadable attachment with <ac:link><ri:attachment ri:filename="NAME"/></ac:link>.'

// ---------------------------------------------------------------------------------------------

const searchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Words to look for, or a full CQL query (e.g. `space = TEAM and label = onboarding`).'),
  space: z.string().optional().describe('Limit to one space key. Ignored when `query` is already CQL.'),
  limit: z.number().int().min(1).max(50).optional().describe('How many results. Default 10.'),
})

/** A query is treated as CQL when it uses CQL's operators; otherwise it is searched as text. */
function toCql(query: string, space: string | undefined): string {
  if (/[=~]|\border by\b/i.test(query)) return query
  const text = `text ~ "${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const inSpace = space !== undefined && space.trim().length > 0 ? ` and space = "${space.trim()}"` : ''
  return `type = page and ${text}${inSpace}`
}

export function createConfluenceSearchTool(options: ConfluenceToolOptions): Tool<z.infer<typeof searchSchema>> {
  return {
    name: 'confluence_search',
    group: 'read',
    description:
      'Search Confluence pages by words or CQL. Returns titles, ids, spaces and links. Use it to ' +
      'find an existing page before writing a new one, so an update goes to the right page ' +
      'instead of creating a near-duplicate.',
    parametersSchema: searchSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        const pages = await client.search(toCql(params.query, params.space), params.limit ?? 10)
        if (pages.length === 0) return { content: `No Confluence pages match: ${params.query}` }
        return {
          content: [
            `${String(pages.length)} page(s):`,
            ...pages.map((page) => `- ${page.title}  (id ${page.id}, space ${page.spaceKey ?? '?'})  ${page.url}`),
          ].join('\n'),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------

const readSchema = z.object({
  pageId: z.string().optional().describe('The page id, from confluence_search or a page URL.'),
  space: z.string().optional().describe('With `title`, find a page by its exact title in this space.'),
  title: z.string().optional(),
  images: z
    .boolean()
    .optional()
    .describe('Also fetch the images attached to the page so you can look at them. Default false.'),
  imageNames: z
    .array(z.string())
    .max(MAX_IMAGES)
    .optional()
    .describe('Only these attachments, by name. Implies images.'),
})

/** Formats a model can look at, on every provider this product speaks. SVG is read as text. */
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function createConfluenceReadPageTool(options: ConfluenceToolOptions): Tool<z.infer<typeof readSchema>> {
  return {
    name: 'confluence_read_page',
    group: 'read',
    description:
      'Read a Confluence page: its title, version, location, attachments and body in storage ' +
      'format. Set images to also look at the pictures on it (diagrams attached as SVG come back ' +
      'as their source). Read a page before updating it — confluence_write_page replaces the ' +
      'whole body, so an edit must start from what is there now.',
    parametersSchema: readSchema,
    async execute(params): Promise<ToolResult> {
      try {
        const client = await options.client()
        let page
        if (params.pageId !== undefined) {
          page = await client.getPage(params.pageId.trim())
        } else {
          const space = params.space ?? options.defaultSpace
          if (space === undefined || params.title === undefined) {
            return {
              content: 'Give a pageId, or a title together with a space (no default space is configured).',
              isError: true,
            }
          }
          page = await client.findPage(space, params.title)
          if (page === undefined) return { content: `No page titled "${params.title}" in space ${space}.` }
        }
        /*
         * Attachments are always listed: replacing an image means attaching a file under the
         * *same name*, and the name is otherwise buried in the body's markup.
         */
        const attachments = await client.listAttachments(page.id).catch(() => [])
        const wanted =
          params.imageNames !== undefined
            ? new Set(params.imageNames.map((name) => name.toLowerCase()))
            : params.images === true
              ? undefined
              : new Set<string>()
        const picked = attachments.filter(
          (attachment) =>
            attachment.mediaType.startsWith('image/') &&
            (wanted === undefined || wanted.has(attachment.name.toLowerCase())),
        )

        const images: NonNullable<ToolResult['images']> = []
        const svgText: string[] = []
        const skipped: string[] = []
        for (const attachment of picked) {
          if (images.length >= MAX_IMAGES) {
            skipped.push(`${attachment.name} (more than ${String(MAX_IMAGES)} images — ask for it by name)`)
            continue
          }
          if (attachment.size > MAX_IMAGE_BYTES) {
            skipped.push(`${attachment.name} (${formatSize(attachment.size)}, too large to show)`)
            continue
          }
          try {
            const bytes = await client.download(attachment.download)
            if (attachment.mediaType === 'image/svg+xml') {
              // SVG is text, and a model reads a diagram's labels and structure better from its
              // source than from pixels. Capped: a pathological SVG can be megabytes of paths.
              svgText.push(`--- ${attachment.name} (SVG source) ---`, bytes.toString('utf8').slice(0, 20_000))
            } else if (VIEWABLE.has(attachment.mediaType)) {
              images.push({ label: attachment.name, mediaType: attachment.mediaType, data: bytes.toString('base64') })
            } else {
              skipped.push(`${attachment.name} (${attachment.mediaType} cannot be shown to a model)`)
            }
          } catch (error) {
            skipped.push(`${attachment.name} (${error instanceof Error ? error.message : String(error)})`)
          }
        }

        const listed =
          attachments.length === 0
            ? ['No attachments.']
            : [
                'Attachments (replace one by attaching a file with the same name):',
                ...attachments.map(
                  (attachment) => `- ${attachment.name}  (${attachment.mediaType}, ${formatSize(attachment.size)})`,
                ),
              ]
        return {
          content: [
            `Title: ${page.title}`,
            `Id: ${page.id}   Version: ${String(page.version)}   Space: ${page.spaceKey ?? '?'}`,
            ...(page.ancestors.length > 0 ? [`Under: ${page.ancestors.join(' › ')}`] : []),
            `Link: ${page.url}`,
            '',
            ...listed,
            ...(images.length > 0
              ? [`Showing ${String(images.length)} image(s): ${images.map((image) => image.label).join(', ')}.`]
              : []),
            ...(skipped.length > 0 ? [`Not shown: ${skipped.join('; ')}`] : []),
            '',
            'Body (storage format):',
            page.body,
            ...(svgText.length > 0 ? ['', ...svgText] : []),
          ].join('\n'),
          ...(images.length > 0 ? { images } : {}),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------

const writeSchema = z.object({
  pageId: z.string().optional().describe('Update this page. Omit to create a new page.'),
  space: z.string().optional().describe('Space key for a new page. Defaults to the configured space.'),
  title: z.string().min(1).max(255).optional().describe('Required for a new page. Omit to keep the current title.'),
  parentId: z.string().optional().describe('Create the new page under this page id.'),
  body: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The complete page body — required for a new page. Omit when updating to change only ' +
        `attachments, e.g. to replace an image by attaching one with the same name. ${STORAGE_GUIDE}`,
    ),
  attachments: z
    .array(
      z.object({
        path: z.string().min(1).describe('A file in the workspace — an image, a JSON export, a PDF.'),
        name: z.string().optional().describe('Name on the page. Defaults to the file name.'),
      }),
    )
    .max(20)
    .optional()
    .describe('Files to attach. Refer to them in the body by name.'),
  diagrams: z
    .array(
      z.object({
        name: z.string().min(1).describe('Attachment name, ending .svg, e.g. "architecture.svg".'),
        diagram: diagramSpecSchema,
      }),
    )
    .max(10)
    .optional()
    .describe('Diagrams to draw and attach as SVG images — the same shape show_diagram takes.'),
})

type WriteParams = z.infer<typeof writeSchema>

/** Everything the write will upload, resolved once so the preview and the write agree. */
interface PreparedFile {
  name: string
  bytes: Uint8Array
  contentType: string
  /** Where it came from, for the preview: a workspace path, or "diagram, 12 nodes". */
  source: string
}

async function prepareFiles(
  params: WriteParams,
  context: ToolExecutionContext,
): Promise<{ ok: true; files: PreparedFile[] } | { ok: false; message: string }> {
  const files: PreparedFile[] = []
  const taken = new Set<string>()
  const claim = (name: string): string | undefined => {
    if (!isSafeAttachmentName(name)) {
      return `"${name}" cannot be an attachment name: letters, digits, spaces, ".", "_", "-" and brackets only.`
    }
    if (taken.has(name.toLowerCase())) return `Two attachments are both called "${name}".`
    taken.add(name.toLowerCase())
    return undefined
  }

  for (const attachment of params.attachments ?? []) {
    // Through the same gate `read_file` uses: confinement, the deny list, and the prompt for a
    // file outside the workspace. A key file must never become a page attachment (invariant 6).
    const resolved = await resolveToolPath(context, attachment.path)
    if (!resolved.ok) return { ok: false, message: resolved.message }
    const name = attachment.name ?? path.basename(resolved.realPath)
    const problem = claim(name)
    if (problem !== undefined) return { ok: false, message: problem }
    let bytes: Buffer
    try {
      bytes = await context.fs.readBytes(resolved.realPath)
    } catch (error) {
      return { ok: false, message: `Could not read ${attachment.path}: ${error instanceof Error ? error.message : String(error)}` }
    }
    files.push({ name, bytes, contentType: contentTypeFor(name), source: resolved.realPath })
  }

  for (const drawn of params.diagrams ?? []) {
    const name = drawn.name.toLowerCase().endsWith('.svg') ? drawn.name : `${drawn.name}.svg`
    const problem = claim(name)
    if (problem !== undefined) return { ok: false, message: problem }
    const svg = diagramSvg(layoutDiagram(drawn.diagram), DEFAULT_PALETTE)
    files.push({
      name,
      bytes: new TextEncoder().encode(svg),
      contentType: 'image/svg+xml',
      source: `diagram "${drawn.diagram.title ?? name}", ${String(drawn.diagram.nodes.length)} node(s)`,
    })
  }
  return { ok: true, files }
}

/**
 * What will be uploaded, with every file that *replaces* one already on the page said so.
 *
 * Replacing an image is the easy thing to approve without noticing — the page text does not
 * change, and a same-named upload silently becomes the new picture — so it is named outright.
 */
function describeFiles(files: readonly PreparedFile[], existingNames: readonly string[]): string {
  if (files.length === 0) return 'No attachments.'
  const existing = new Set(existingNames.map((name) => name.toLowerCase()))
  return [
    `${String(files.length)} attachment(s):`,
    ...files.map(
      (file) =>
        `- ${file.name}  (${formatSize(file.bytes.length)}, from ${file.source})` +
        (existing.has(file.name.toLowerCase()) ? '  — REPLACES the attachment of this name on the page' : ''),
    ),
  ].join('\n')
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function createConfluenceWritePageTool(options: ConfluenceToolOptions): Tool<WriteParams> {
  return {
    name: 'confluence_write_page',
    group: 'edit',
    description:
      'Create a Confluence page, or update one when given its pageId, with optional attached files ' +
      'and drawn diagrams. A body replaces the whole page, so read an existing page first and edit ' +
      'from its current body. To replace an image, give the pageId and attach a file or diagram ' +
      'with exactly the same name as the existing attachment — the body can then be left out. ' +
      'Make pages easy to scan: a short summary first, headings, tables for settings, info/note ' +
      'panels for warnings, code blocks for anything to copy, and a diagram where a picture ' +
      'explains the structure faster than prose. Always shown to the user before anything is ' +
      'published.' +
      /*
       * The default space is stated, not only applied. A model that does not know one is set asks
       * the user which space to use — a question the user already answered in Settings. Fixed for
       * the session like every description (§12): it changes only when the setting does.
       */
      (options.defaultSpace !== undefined
        ? ` New pages go to space ${options.defaultSpace} unless the user asks for another — leave space out for that.`
        : ' No default space is configured, so a new page needs a space key; ask the user if they have not given one.'),
    parametersSchema: writeSchema,

    async preview(params, context): Promise<ToolPreview> {
      const prepared = await prepareFiles(params, context)
      if (params.pageId !== undefined) {
        // The real current page, so the user approves a change to what is actually there.
        const client = await options.client()
        const current = await client.getPage(params.pageId.trim())
        const existing = await client.listAttachments(current.id).catch(() => [])
        const files = prepared.ok
          ? describeFiles(prepared.files, existing.map((attachment) => attachment.name))
          : `Attachments cannot be prepared: ${prepared.message}`
        const title = params.title ?? current.title
        if (params.body === undefined) {
          // Attachments only: the text is untouched, so there is no diff to show — only the files.
          return {
            kind: 'text',
            text: `Confluence page "${current.title}" (${current.url}). The page text is left as it is.\n${files}`,
          }
        }
        return {
          kind: 'diff',
          path: `Confluence: ${current.title} (${current.url})`,
          before: current.body,
          after: params.body,
          note:
            (title !== current.title ? `Renamed to "${title}". ` : '') +
            `Version ${String(current.version)} → ${String(current.version + 1)}. ${files}`,
        }
      }
      const files = prepared.ok ? describeFiles(prepared.files, []) : `Attachments cannot be prepared: ${prepared.message}`
      if (params.body === undefined || params.title === undefined) {
        return { kind: 'text', text: 'A new page needs a title and a body; this call will be refused.' }
      }
      const space = params.space ?? options.defaultSpace ?? '(no space given)'
      return {
        kind: 'diff',
        path: `Confluence: new page "${params.title}" in ${space}${params.parentId !== undefined ? ` under page ${params.parentId}` : ''}`,
        before: '',
        after: params.body,
        note: files,
      }
    },

    async execute(params, context): Promise<ToolResult> {
      try {
        const prepared = await prepareFiles(params, context)
        if (!prepared.ok) return { content: prepared.message, isError: true }
        const client = await options.client()

        let page
        if (params.pageId !== undefined) {
          const current = await client.getPage(params.pageId.trim())
          const title = params.title ?? current.title
          // Attachments only, with the title unchanged: no new version of the text is written.
          page =
            params.body === undefined && title === current.title
              ? current
              : await client.updatePage({
                  id: current.id,
                  title,
                  body: params.body ?? current.body,
                  version: current.version,
                })
        } else {
          if (params.title === undefined || params.body === undefined) {
            return { content: 'A new page needs both a title and a body.', isError: true }
          }
          const space = params.space ?? options.defaultSpace
          if (space === undefined) {
            return {
              content: 'No space was given and no default space is configured (Settings → Atlassian → Confluence).',
              isError: true,
            }
          }
          page = await client.createPage({
            spaceKey: space,
            title: params.title,
            body: params.body,
            parentId: params.parentId,
          })
        }

        /*
         * After the page, because an attachment needs a page to belong to. The body's
         * `ri:attachment` references resolve when the page is viewed, so the order is invisible to
         * readers. A failure here is reported without undoing the page: the text is published and
         * correct, and saying which file did not make it is more use than pretending nothing did.
         */
        const failed: string[] = []
        for (const file of prepared.files) {
          try {
            await client.attach(page.id, file)
          } catch (error) {
            failed.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        return {
          content: [
            `${params.pageId !== undefined ? 'Updated' : 'Created'} "${page.title}" (id ${page.id}).`,
            `Link: ${page.url}`,
            ...(prepared.files.length > 0
              ? [`Attached ${String(prepared.files.length - failed.length)} of ${String(prepared.files.length)} file(s).`]
              : []),
            ...(failed.length > 0 ? ['Not attached:', ...failed.map((line) => `- ${line}`)] : []),
          ].join('\n'),
          ...(failed.length > 0 ? { isError: true } : {}),
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}
