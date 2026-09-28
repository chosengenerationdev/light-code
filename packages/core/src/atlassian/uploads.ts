import path from 'node:path'

import { z } from 'zod'

import { layoutDiagram } from '../diagrams/layout.js'
import { DEFAULT_PALETTE, diagramSvg } from '../diagrams/svg.js'
import { diagramSpecSchema } from '../diagrams/types.js'
import { resolveToolPath } from '../tools/paths.js'
import type { ToolExecutionContext } from '../tools/types.js'

/**
 * Files and drawn diagrams going up to a Confluence page or a Jira issue.
 *
 * One implementation for both, because the rules are the rules of *the file*, not of the product:
 * a workspace path goes through the same gate `read_file` uses (confinement, the deny list, the
 * prompt for a file outside the workspace), so a key file can never become an attachment
 * (invariant 6); a name is checked before it reaches a multipart header; and a diagram is drawn by
 * the same renderer `show_diagram` uses, which escapes every label.
 */

/** Filenames an attachment may have: what a person would type, and nothing that reaches a header. */
export function isSafeAttachmentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,199}$/.test(name) && !name.includes('..')
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  json: 'application/json',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export function contentTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * A one-file multipart body, assembled as bytes.
 *
 * A PNG round-tripped through a string is corrupted without anything reporting it, so the file is
 * spliced in as bytes (see `HttpRequestOptions.bodyBytes`).
 */
export function multipartBody(
  file: { name: string; bytes: Uint8Array; contentType?: string | undefined },
  fields: Record<string, string> = {},
): { contentType: string; bytes: Uint8Array } {
  const boundary = `lightcode${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    `Content-Type: ${file.contentType ?? contentTypeFor(file.name)}\r\n\r\n`
  const tail =
    '\r\n' +
    Object.entries(fields)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join('') +
    `--${boundary}--\r\n`
  const encoder = new TextEncoder()
  const headBytes = encoder.encode(head)
  const tailBytes = encoder.encode(tail)
  const bytes = new Uint8Array(headBytes.length + file.bytes.length + tailBytes.length)
  bytes.set(headBytes, 0)
  bytes.set(file.bytes, headBytes.length)
  bytes.set(tailBytes, headBytes.length + file.bytes.length)
  return { contentType: `multipart/form-data; boundary=${boundary}`, bytes }
}

export function attachmentsSchema(where: string, refer: string) {
  return z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .describe('A file in the workspace — an image, a log, a JSON export, a PDF.'),
        name: z.string().optional().describe(`Name on the ${where}. Defaults to the file name.`),
      }),
    )
    .max(20)
    .optional()
    .describe(`Files to attach. ${refer}`)
}

export const diagramsSchema = z
  .array(
    z.object({
      name: z.string().min(1).describe('Attachment name, ending .svg, e.g. "architecture.svg".'),
      diagram: diagramSpecSchema,
    }),
  )
  .max(10)
  .optional()
  .describe('Diagrams to draw and attach as SVG images — the same shape show_diagram takes.')

export interface UploadParams {
  attachments?: { path: string; name?: string | undefined }[] | undefined
  diagrams?: z.infer<typeof diagramsSchema>
}

/** Everything a write will upload, resolved once so the preview and the write agree. */
export interface PreparedFile {
  name: string
  bytes: Uint8Array
  contentType: string
  /** Where it came from, for the preview: a workspace path, or "diagram, 12 nodes". */
  source: string
}

export async function prepareUploads(
  params: UploadParams,
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
    const resolved = await resolveToolPath(context, attachment.path)
    if (!resolved.ok) return { ok: false, message: resolved.message }
    const name = attachment.name ?? path.basename(resolved.realPath)
    const problem = claim(name)
    if (problem !== undefined) return { ok: false, message: problem }
    let bytes: Buffer
    try {
      bytes = await context.fs.readBytes(resolved.realPath)
    } catch (error) {
      return {
        ok: false,
        message: `Could not read ${attachment.path}: ${error instanceof Error ? error.message : String(error)}`,
      }
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
 * What will be uploaded, with every file that collides with an existing one said so.
 *
 * `collision` is the product's own behaviour: Confluence replaces an attachment of the same name,
 * which is the easy thing to approve without noticing because no text changes; Jira keeps both.
 */
export function describeUploads(
  files: readonly PreparedFile[],
  existingNames: readonly string[],
  collision: string,
): string {
  if (files.length === 0) return 'No attachments.'
  const existing = new Set(existingNames.map((name) => name.toLowerCase()))
  return [
    `${String(files.length)} attachment(s):`,
    ...files.map(
      (file) =>
        `- ${file.name}  (${formatSize(file.bytes.length)}, from ${file.source})` +
        (existing.has(file.name.toLowerCase()) ? `  — ${collision}` : ''),
    ),
  ].join('\n')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
