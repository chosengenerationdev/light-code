import { z } from 'zod'

import { resolveToolPath } from '../tools/paths.js'
import type { Tool, ToolResult } from '../tools/types.js'
import type { S3Client } from './client.js'
import { confineKey, displayKey, normalisePrefix } from './keys.js'

/**
 * Reading and writing an S3 bucket.
 *
 * Four tools rather than one with a mode, because they do not carry the same risk and §8's gate
 * works on tool names: listing and reading change nothing, downloading writes to this disk, and
 * uploading writes to a bucket other people can see. Folding them together would mean one
 * approval decision covering all four.
 */

export interface S3ToolOptions {
  client: S3Client
  /** The connection's label, so a result says which bucket it came from. */
  label: string
  bucket: string
  /** Everything is confined to this. See `keys.ts` for why it is enforced rather than trusted. */
  prefix?: string
  /** Set when the connection is attached for reading only; upload is then not registered at all. */
  readOnly?: boolean
}

/** Text that is plainly not text, so a binary file is reported rather than printed as mojibake. */
function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8000)
  // A NUL byte is the reliable signal; UTF-8 text never contains one.
  return sample.includes(0)
}

function describeSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const listSchema = z.object({
    prefix: z
      .string()
      .optional()
      .describe('Folder to list, relative to the connection’s own prefix. Omit for everything.'),
  limit: z.number().int().min(1).max(1000).optional().describe('How many to return. Default 100.'),
})

export function createS3ListTool(options: S3ToolOptions): Tool<z.infer<typeof listSchema>> {
  return {
    name: 's3_list_files',
    group: 'read',
    description:
      `List files in the S3 bucket "${options.label}". Use it to find what is there before ` +
      'reading or downloading. Returns keys, sizes and dates, not contents.',
    parametersSchema: listSchema,
    async execute(params, context): Promise<ToolResult> {
      const base = normalisePrefix(options.prefix)
      const where = params.prefix === undefined ? base : normalisePrefix(`${base}${params.prefix}`)
      try {
        const found = await options.client.list(where, params.limit ?? 100, context.signal)
        if (found.length === 0) return { content: `No files under "${where === '' ? '/' : where}".` }
        const lines = found.map(
          (object) =>
            `${displayKey(object.key, options.prefix)}  ${describeSize(object.size)}  ${object.lastModified}`,
        )
        return { content: [`${String(found.length)} file(s) in ${options.bucket}:`, ...lines].join('\n') }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

const readSchema = z.object({
  key: z.string().min(1).describe('The file to read, as s3_list_files reports it.'),
})

export function createS3ReadTool(options: S3ToolOptions): Tool<z.infer<typeof readSchema>> {
  return {
    name: 's3_read_file',
    group: 'read',
    description:
      `Read a file from the S3 bucket "${options.label}" as text. For anything that is not text, ` +
      'use s3_download_file and open it locally.',
    parametersSchema: readSchema,
    async execute(params, context): Promise<ToolResult> {
      const resolved = confineKey(params.key, options.prefix)
      if (!resolved.ok) return { content: resolved.message, isError: true }
      try {
        const bytes = await options.client.get(resolved.key, context.signal)
        if (looksBinary(bytes)) {
          /*
           * Withheld rather than returned as text, which is `documents/pdf.ts`'s rule: a model
           * handed mojibake summarises it confidently and is wrong, which is worse than being
           * told to fetch the file properly.
           */
          return {
            content:
              `"${params.key}" is ${describeSize(bytes.length)} of binary data, not text. ` +
              'Use s3_download_file to copy it here and open it with a tool that understands it.',
          }
        }
        return { content: bytes.toString('utf8') }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

const downloadSchema = z.object({
  key: z.string().min(1).describe('The file in the bucket.'),
  to: z.string().min(1).describe('Where to write it, relative to the workspace root.'),
})

export function createS3DownloadTool(options: S3ToolOptions): Tool<z.infer<typeof downloadSchema>> {
  return {
    name: 's3_download_file',
    group: 'edit',
    description: `Copy a file out of the S3 bucket "${options.label}" onto this machine.`,
    parametersSchema: downloadSchema,
    preview: async (params) => ({
      kind: 'text',
      text: `Copy s3://${options.bucket}/${params.key}\n     to ${params.to}`,
    }),
    async execute(params, context): Promise<ToolResult> {
      const resolved = confineKey(params.key, options.prefix)
      if (!resolved.ok) return { content: resolved.message, isError: true }
      // The local half goes through the ordinary path check, so the deny list and the workspace
      // boundary apply exactly as they do to `write_to_file` (invariants 5 and 6).
      const target = await resolveToolPath(context, params.to)
      if (!target.ok) return { content: target.message, isError: true }

      try {
        const bytes = await options.client.get(resolved.key, context.signal)
        await context.fs.writeBytes(target.realPath, bytes)
        return {
          content: `Wrote ${describeSize(bytes.length)} to ${params.to} from s3://${options.bucket}/${resolved.key}.`,
          path: target.realPath,
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

const uploadSchema = z.object({
  from: z.string().min(1).describe('The local file to upload, relative to the workspace root.'),
  key: z.string().min(1).describe('Where to put it in the bucket.'),
})

export function createS3UploadTool(options: S3ToolOptions): Tool<z.infer<typeof uploadSchema>> {
  return {
    name: 's3_upload_file',
    group: 'edit',
    description: `Copy a file from this machine into the S3 bucket "${options.label}".`,
    parametersSchema: uploadSchema,
    /*
     * The preview names the destination in full, including the bucket.
     *
     * Invariant 8: this is the one thing the person approving needs and cannot otherwise check.
     * A file going to the wrong bucket is not recoverable by undoing anything here — it is on
     * somebody else's storage, and possibly visible to people the user did not intend.
     */
    preview: async (params) => ({
      kind: 'text',
      text: `Upload ${params.from}\n    to s3://${options.bucket}/${normalisePrefix(options.prefix)}${params.key}`,
    }),
    async execute(params, context): Promise<ToolResult> {
      if (options.readOnly === true) {
        return { content: `The connection "${options.label}" is read-only.`, isError: true }
      }
      const resolved = confineKey(params.key, options.prefix)
      if (!resolved.ok) return { content: resolved.message, isError: true }
      const source = await resolveToolPath(context, params.from)
      if (!source.ok) return { content: source.message, isError: true }

      try {
        const bytes = await context.fs.readBytes(source.realPath)
        await options.client.put(resolved.key, bytes, undefined, context.signal)
        return {
          content: `Uploaded ${describeSize(bytes.length)} to s3://${options.bucket}/${resolved.key}.`,
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}
