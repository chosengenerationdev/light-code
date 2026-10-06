/**
 * A file dropped or attached in the chat that is too big, or not text, to paste into the message.
 *
 * Reported: "whenever I drag and drop a file or email item, it says file size is big and asks me to
 * save the file locally and let it know - defeats the purpose of easy usage". The panel used to read
 * a dropped file as text in the browser and refuse anything over 512 KB or containing a NUL - which
 * is every PDF, workbook and Outlook message. The panel cannot read those formats; the host can, so
 * the bytes come here, are saved to a temporary folder (never the workspace - a dropped file is not
 * part of the project and must not land in git), and are read with the same extractors `read_file`
 * uses. What goes into the message is the text, capped, with the saved path so `read_file` can page
 * through the rest.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { documentKindFor, extractDocument } from './extract.js'
import { parseMsg } from './msg.js'

/** Where dropped files are saved, one folder per session beneath it. */
export function droppedFilesRoot(): string {
  return path.join(os.tmpdir(), 'light-code-drops')
}

/** Where `outlook_read_email` saves a message's attachments to read them. */
export function mailAttachmentsRoot(): string {
  return path.join(os.tmpdir(), 'light-code-mail')
}

export interface StagedFile {
  name: string
  /** Where the bytes were saved; readable by `read_file`. */
  path: string
  /** What goes into the message: the extracted text, or a sentence saying why there is none. */
  text: string
  /** True when `text` is only the start of the file. */
  truncated: boolean
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i

/** A Windows-safe file name; the original is kept for display. */
export function safeFileName(name: string): string {
  const cleaned = Array.from(name, (char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '_' : char))
    .join('')
    .replace(/^\.+/, '_')
    .trim()
  return (cleaned.length > 0 ? cleaned : 'attachment').slice(0, 150)
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0)
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
}

/** Saves `bytes` under `dir` without replacing anything already there. */
async function saveUnique(dir: string, name: string, bytes: Buffer): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const safe = safeFileName(name)
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = path.join(dir, attempt === 0 ? safe : `${stem} (${String(attempt + 1)})${ext}`)
    try {
      await fs.writeFile(candidate, bytes, { flag: 'wx' })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Could not find a free name for ${name} in ${dir}.`)
}

/** The readable text of one saved file, or a sentence saying why there is none. Never throws. */
function readableText(name: string, savedPath: string, bytes: Buffer): string {
  if (IMAGE_FILE.test(name)) return `(a picture, ${formatSize(bytes.length)}, saved at ${savedPath})`
  const kind = documentKindFor(name)
  if (kind === 'text' && looksBinary(bytes)) {
    return `(${formatSize(bytes.length)}; not a format Light Code can read as text - saved at ${savedPath})`
  }
  try {
    const extracted = extractDocument(name, bytes)
    return extracted.note !== undefined && kind !== 'msg' ? `${extracted.text}\n\n(${extracted.note})` : extracted.text
  } catch (error) {
    return `(could not be read: ${error instanceof Error ? error.message : String(error)} - saved at ${savedPath})`
  }
}

function cap(text: string, limit: number, savedPath: string): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return {
    text: `${text.slice(0, limit)}\n… (cut here at ${String(limit)} characters; the whole file is at ${savedPath} - read it with read_file to see the rest)`,
    truncated: true,
  }
}

export interface StageOptions {
  /** Characters of the dropped file's own text that go into the message. */
  textCap?: number
  /** Characters per attachment inside a dropped email. */
  attachmentCap?: number
}

/**
 * Saves a dropped file under `dir` and returns what to put in the message. A dropped Outlook
 * message has its attachments saved beside it and read too - the email asked about is rarely
 * only its body.
 */
export async function stageDroppedFile(
  dir: string,
  name: string,
  bytes: Buffer,
  options: StageOptions = {},
): Promise<StagedFile> {
  const textCap = options.textCap ?? 60_000
  const attachmentCap = options.attachmentCap ?? 20_000
  const display = name.trim().length > 0 ? name.trim() : 'attachment'
  const savedPath = await saveUnique(dir, display, bytes)
  const body = readableText(display, savedPath, bytes)
  const head = cap(body, textCap, savedPath)
  if (documentKindFor(display) !== 'msg') return { name: display, path: savedPath, ...head }

  let parsed: ReturnType<typeof parseMsg> | undefined
  try {
    parsed = parseMsg(bytes)
  } catch {
    return { name: display, path: savedPath, ...head }
  }
  if (parsed.attachments.length === 0) return { name: display, path: savedPath, ...head }

  const folder = path.join(path.dirname(savedPath), `${path.basename(savedPath, path.extname(savedPath))} attachments`)
  const parts: string[] = [head.text]
  for (const attachment of parsed.attachments) {
    if (attachment.data === undefined) {
      parts.push(`--- Attachment: ${attachment.name} (not read: an attached email or a link, not a file stored in the message) ---`)
      continue
    }
    try {
      const saved = await saveUnique(folder, attachment.name, attachment.data)
      const inner = cap(readableText(attachment.name, saved, attachment.data), attachmentCap, saved)
      parts.push(`--- Attachment: ${attachment.name} (${formatSize(attachment.data.length)}, saved at ${saved}) ---`, inner.text)
    } catch (error) {
      parts.push(`--- Attachment: ${attachment.name} (could not be saved: ${error instanceof Error ? error.message : String(error)}) ---`)
    }
  }
  return { name: display, path: savedPath, text: parts.join('\n'), truncated: head.truncated }
}
