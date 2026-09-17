import { z } from 'zod'

import { resolveToolPath } from '../tools/paths.js'
import type { Tool, ToolResult } from '../tools/types.js'
import type { S3Client } from './client.js'
import { confineKey, displayKey, normalisePrefix } from './keys.js'

/**
 * Reading and writing an S3 bucket.
 *
 * Four tools rather than one with a mode, because they do not carry the same risk and §8's gate
 * works on tool *names*: listing and reading change nothing, downloading writes to this disk, and
 * uploading writes to storage other people can see. Folded together, one approval would cover all
 * four, and "always allow s3_read_file" would silently also allow uploads.
 */

/** One configured bucket, ready to use. */
export interface S3Target {
  id: string
  label: string
  bucket: string
  client: S3Client
  /** Everything is confined to this. See `keys.ts` for why it is enforced rather than trusted. */
  prefix?: string
  readOnly?: boolean
}

/**
 * Picks the bucket a call meant.
 *
 * With one configured there is nothing to choose and the parameter may be omitted — which is the
 * ordinary case, and asking a model to name it every time is a step it can get wrong for no
 * benefit. With several, a missing or unknown name is refused **with the list**, rather than
 * silently acting on the first: uploading to the wrong bucket is not undoable from here.
 */
function pick(targets: readonly S3Target[], wanted: string | undefined): S3Target | string {
  if (wanted === undefined) {
    if (targets.length === 1) return targets[0] as S3Target
    return `Several buckets are configured. Name one with "connection": ${targets.map((target) => target.label).join(', ')}.`
  }
  const found = targets.find(
    (target) => target.label.toLowerCase() === wanted.toLowerCase() || target.id === wanted,
  )
  if (found !== undefined) return found
  return `There is no S3 connection called "${wanted}". Configured: ${targets.map((target) => target.label).join(', ')}.`
}

/** Text that is plainly not text, so a binary file is reported rather than printed as mojibake. */
function looksBinary(bytes: Buffer): boolean {
  // A NUL byte is the reliable signal; UTF-8 text never contains one.
  return bytes.subarray(0, 8000).includes(0)
}

function describeSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const failed = (error: unknown): ToolResult => ({
  content: error instanceof Error ? error.message : String(error),
  isError: true,
})

/**
 * Names the buckets in the description.
 *
 * Varies with configuration rather than with the turn, so the tool block stays byte-stable for a
 * whole session — the carve-out §12 already makes, and the same thing `search_codebase` does with
 * its scopes. Without it the model has no way to learn what "connection" accepts.
 */
function whichBuckets(targets: readonly S3Target[]): string {
  return targets.length === 1
    ? `the S3 bucket "${targets[0]?.label ?? ''}"`
    : `an S3 bucket (${targets.map((target) => target.label).join(', ')})`
}

const connectionField = z
  .string()
  .optional()
  .describe('Which configured bucket to use. May be omitted when only one is set up.')

const listSchema = z.object({
  connection: connectionField,
  prefix: z
    .string()
    .optional()
    .describe('Folder to list, relative to the connection’s own prefix. Omit for everything.'),
  limit: z.number().int().min(1).max(1000).optional().describe('How many to return. Default 100.'),
})

export function createS3ListTool(targets: readonly S3Target[]): Tool<z.infer<typeof listSchema>> {
  return {
    name: 's3_list_files',
    group: 'read',
    description:
      `List files in ${whichBuckets(targets)}. Use it to find what is there before reading or ` +
      'downloading. Returns keys, sizes and dates, never contents.',
    parametersSchema: listSchema,
    async execute(params, context): Promise<ToolResult> {
      const target = pick(targets, params.connection)
      if (typeof target === 'string') return { content: target, isError: true }

      const base = normalisePrefix(target.prefix)
      const where = params.prefix === undefined ? base : normalisePrefix(`${base}${params.prefix}`)
      try {
        const found = await target.client.list(where, params.limit ?? 100, context.signal)
        if (found.length === 0) return { content: `No files under "${where === '' ? '/' : where}".` }
        const lines = found.map(
          (object) =>
            `${displayKey(object.key, target.prefix)}  ${describeSize(object.size)}  ${object.lastModified}`,
        )
        return { content: [`${String(found.length)} file(s) in ${target.bucket}:`, ...lines].join('\n') }
      } catch (error) {
        return failed(error)
      }
    },
  }
}

const readSchema = z.object({
  connection: connectionField,
  key: z.string().min(1).describe('The file to read, as s3_list_files reports it.'),
})

export function createS3ReadTool(targets: readonly S3Target[]): Tool<z.infer<typeof readSchema>> {
  return {
    name: 's3_read_file',
    group: 'read',
    description:
      `Read a file from ${whichBuckets(targets)} as text. For anything that is not text, use ` +
      's3_download_file and open it locally.',
    parametersSchema: readSchema,
    async execute(params, context): Promise<ToolResult> {
      const target = pick(targets, params.connection)
      if (typeof target === 'string') return { content: target, isError: true }

      const resolved = confineKey(params.key, target.prefix)
      if (!resolved.ok) return { content: resolved.message, isError: true }
      try {
        const bytes = await target.client.get(resolved.key, context.signal)
        if (looksBinary(bytes)) {
          /*
           * Withheld rather than returned as text, which is `documents/pdf.ts`'s rule: a model
           * handed mojibake summarises it confidently and is wrong, which is worse than being
           * told to fetch the file properly.
           */
          return {
            content:
              `"${params.key}" is ${describeSize(bytes.length)} of binary data, not text. ` +
              'Use s3_download_file to copy it here and open it with something that understands it.',
          }
        }
        return { content: bytes.toString('utf8') }
      } catch (error) {
        return failed(error)
      }
    },
  }
}

const downloadSchema = z.object({
  connection: connectionField,
  key: z.string().min(1).describe('The file in the bucket.'),
  to: z.string().min(1).describe('Where to write it, relative to the workspace root.'),
})

export function createS3DownloadTool(targets: readonly S3Target[]): Tool<z.infer<typeof downloadSchema>> {
  return {
    name: 's3_download_file',
    group: 'edit',
    description: `Copy a file out of ${whichBuckets(targets)} onto this machine.`,
    parametersSchema: downloadSchema,
    preview: async (params) => {
      const target = pick(targets, params.connection)
      const where = typeof target === 'string' ? '(unknown bucket)' : `s3://${target.bucket}/${params.key}`
      return { kind: 'text', text: `Copy ${where}\n     to ${params.to}` }
    },
    async execute(params, context): Promise<ToolResult> {
      const target = pick(targets, params.connection)
      if (typeof target === 'string') return { content: target, isError: true }

      const resolved = confineKey(params.key, target.prefix)
      if (!resolved.ok) return { content: resolved.message, isError: true }
      // The local half goes through the ordinary path check, so the deny list and the workspace
      // boundary apply exactly as they do to `write_to_file` (invariants 5 and 6).
      const to = await resolveToolPath(context, params.to)
      if (!to.ok) return { content: to.message, isError: true }

      try {
        const bytes = await target.client.get(resolved.key, context.signal)
        await context.fs.writeBytes(to.realPath, bytes)
        return {
          content: `Wrote ${describeSize(bytes.length)} to ${params.to} from s3://${target.bucket}/${resolved.key}.`,
          path: to.realPath,
        }
      } catch (error) {
        return failed(error)
      }
    },
  }
}

const uploadSchema = z.object({
  connection: connectionField,
  from: z.string().min(1).describe('The local file to upload, relative to the workspace root.'),
  key: z.string().min(1).describe('Where to put it in the bucket.'),
})

export function createS3UploadTool(targets: readonly S3Target[]): Tool<z.infer<typeof uploadSchema>> {
  return {
    name: 's3_upload_file',
    group: 'edit',
    description: `Copy a file from this machine into ${whichBuckets(targets)}.`,
    parametersSchema: uploadSchema,
    /*
     * The preview names the destination in full, bucket included.
     *
     * Invariant 8: this is the one thing the person approving needs and cannot otherwise check.
     * A file sent to the wrong bucket is not recoverable by undoing anything here — it is on
     * somebody else's storage, possibly visible to people the user never intended.
     */
    preview: async (params) => {
      const target = pick(targets, params.connection)
      const where =
        typeof target === 'string'
          ? '(unknown bucket)'
          : `s3://${target.bucket}/${normalisePrefix(target.prefix)}${params.key}`
      return { kind: 'text', text: `Upload ${params.from}\n    to ${where}` }
    },
    async execute(params, context): Promise<ToolResult> {
      const target = pick(targets, params.connection)
      if (typeof target === 'string') return { content: target, isError: true }
      if (target.readOnly === true) {
        return { content: `The connection "${target.label}" is read-only.`, isError: true }
      }

      const resolved = confineKey(params.key, target.prefix)
      if (!resolved.ok) return { content: resolved.message, isError: true }
      const from = await resolveToolPath(context, params.from)
      if (!from.ok) return { content: from.message, isError: true }

      try {
        const bytes = await context.fs.readBytes(from.realPath)
        await target.client.put(resolved.key, bytes, undefined, context.signal)
        return { content: `Uploaded ${describeSize(bytes.length)} to s3://${target.bucket}/${resolved.key}.` }
      } catch (error) {
        return failed(error)
      }
    },
  }
}

/** Every S3 tool, for a set of configured buckets. Empty in, nothing out. */
export function createS3Tools(targets: readonly S3Target[]): Tool<never>[] {
  if (targets.length === 0) return []
  return [
    createS3ListTool(targets),
    createS3ReadTool(targets),
    createS3DownloadTool(targets),
    createS3UploadTool(targets),
  ] as unknown as Tool<never>[]
}
