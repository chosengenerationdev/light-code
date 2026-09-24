import { CompoundFile, CompoundFileError, isCompoundFile, type CompoundEntry } from './cfbf.js'

/**
 * Reading an Outlook `.msg` file.
 *
 * Reported: *"light couldn't read the outlook msg file"*. It could not, and the way it failed was
 * the worst available — a `.msg` is a compound file, so it fell through to being decoded as UTF-8
 * and came back as pages of mojibake with fragments of real text in it. A model handed that
 * summarises it confidently. `pdf.ts` already refuses to return glyph soup for exactly this
 * reason; this is the same rule applied to a second binary format.
 *
 * ## What a `.msg` actually is
 *
 * A compound file (see `cfbf.ts`) whose streams are named after MAPI property tags:
 * `__substg1.0_<tag><type>`, where the tag is the property and the type says how to decode it.
 * Recipients and attachments are *storages* — `__recip_version1.0_#00000000` and
 * `__attach_version1.0_#00000000` — each holding the same shape of property streams.
 *
 * ## Why the body is preferred over the HTML body
 *
 * Both are usually present. `office/mailFormat.ts` records why the HTML one is the wrong thing to
 * hand a model: an Outlook body is thousands of tokens of `mso-` markup around a few lines of
 * text. So the plain-text body is used when there is one, the RTF body is **not** decompressed
 * (that is a second compression format for a copy of the same words), and the HTML body is only a
 * fallback — stripped, not passed through.
 */

/** MAPI property types, as the last four hex digits of a stream name. */
const TYPE_STRING8 = '001e'
const TYPE_UNICODE = '001f'
const TYPE_BINARY = '0102'
const TYPE_SYSTIME = '0040'

/** The properties worth reading, by tag. */
const TAG = {
  subject: '0037',
  body: '1000',
  htmlBody: '1013',
  senderName: '0c1a',
  senderEmail: '0c1f',
  sentRepresentingName: '0042',
  sentRepresentingEmail: '0065',
  displayTo: '0e04',
  displayCc: '0e03',
  displayBcc: '0e02',
  clientSubmitTime: '0039',
  deliveryTime: '0e06',
  attachLongFilename: '3707',
  attachFilename: '3704',
  attachSize: '0e20',
  recipientName: '3001',
  recipientEmail: '39fe',
  recipientSmtp: '3003',
  recipientType: '0c15',
} as const

export interface MsgAttachment {
  name: string
  size?: number | undefined
}

export interface MsgRecipient {
  name: string
  email?: string | undefined
  /** 1 To, 2 Cc, 3 Bcc. Absent when the file does not say. */
  kind?: number | undefined
}

export interface ParsedMsg {
  subject?: string | undefined
  from?: string | undefined
  to?: string | undefined
  cc?: string | undefined
  bcc?: string | undefined
  sent?: Date | undefined
  body: string
  /** True when the body came from the HTML copy because there was no plain-text one. */
  bodyFromHtml: boolean
  attachments: MsgAttachment[]
  recipients: MsgRecipient[]
}

export function isMsgFile(buffer: Buffer): boolean {
  return isCompoundFile(buffer)
}

/** `__substg1.0_0037001F` -> `{ tag: '0037', type: '001f' }`. */
function propertyOf(name: string): { tag: string; type: string } | undefined {
  const match = /^__substg1\.0_([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})$/.exec(name)
  if (match === null) return undefined
  return { tag: (match[1] as string).toLowerCase(), type: (match[2] as string).toLowerCase() }
}

/** Every property stream directly inside one storage, keyed `tag+type`. */
function propertiesIn(file: CompoundFile, storageId: number): Map<string, CompoundEntry> {
  const found = new Map<string, CompoundEntry>()
  for (const child of file.childrenOf(storageId)) {
    if (child.type !== 2) continue
    const property = propertyOf(child.name)
    if (property === undefined) continue
    found.set(property.tag + property.type, child)
  }
  return found
}

function readString(
  file: CompoundFile,
  properties: Map<string, CompoundEntry>,
  tag: string,
): string | undefined {
  /*
   * Unicode first, then the 8-bit form. Both can be present, and the 8-bit one is whatever
   * code page the sender's machine used - readable for English and wrong for everything else,
   * which is the kind of wrong that is only noticed by the person whose name it mangles.
   */
  const unicode = properties.get(tag + TYPE_UNICODE)
  if (unicode !== undefined) return trimNul(file.read(unicode).toString('utf16le'))
  const ansi = properties.get(tag + TYPE_STRING8)
  if (ansi !== undefined) return trimNul(file.read(ansi).toString('latin1'))
  return undefined
}

function trimNul(value: string): string {
  return value.replace(/\0+$/, '')
}

/**
 * A FILETIME property: 100-nanosecond ticks since 1601.
 *
 * Returned as a `Date` or not at all. A message with no send time is ordinary — a draft has
 * never been sent — and inventing one would put a plausible wrong date in front of somebody.
 */
function readTime(
  file: CompoundFile,
  properties: Map<string, CompoundEntry>,
  tag: string,
): Date | undefined {
  const entry = properties.get(tag + TYPE_SYSTIME)
  if (entry === undefined) return undefined
  const raw = file.read(entry)
  if (raw.length < 8) return undefined
  const ticks = raw.readUInt32LE(0) + raw.readUInt32LE(4) * 0x1_0000_0000
  if (ticks === 0) return undefined
  // 11644473600 seconds between 1601-01-01 and the Unix epoch.
  const millis = ticks / 10_000 - 11_644_473_600_000
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date : undefined
}

/** Tags out of an HTML body, when that is all there is. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function parseMsg(buffer: Buffer): ParsedMsg {
  const file = new CompoundFile(buffer)
  const top = propertiesIn(file, 0)

  const attachments: MsgAttachment[] = []
  const recipients: MsgRecipient[] = []
  for (const child of file.childrenOf(0)) {
    if (child.type !== 1) continue
    const id = file.list().indexOf(child)
    if (id < 0) continue
    const properties = propertiesIn(file, id)

    if (child.name.startsWith('__attach_version1.0')) {
      const name =
        readString(file, properties, TAG.attachLongFilename) ??
        readString(file, properties, TAG.attachFilename)
      // An attachment with no name at all is usually an inline image; it is still an
      // attachment and saying "1 unnamed" beats leaving it out of the count.
      attachments.push({ name: name !== undefined && name.length > 0 ? name : '(unnamed)' })
      continue
    }

    if (child.name.startsWith('__recip_version1.0')) {
      const name = readString(file, properties, TAG.recipientName)
      const email =
        readString(file, properties, TAG.recipientSmtp) ??
        readString(file, properties, TAG.recipientEmail)
      if (name !== undefined || email !== undefined) {
        recipients.push({ name: name ?? email ?? '', ...(email !== undefined ? { email } : {}) })
      }
    }
  }

  const plain = readString(file, top, TAG.body)
  let body = plain
  let bodyFromHtml = false
  if (body === undefined || body.trim().length === 0) {
    const htmlEntry = top.get(TAG.htmlBody + TYPE_BINARY)
    if (htmlEntry !== undefined) {
      body = stripHtml(file.read(htmlEntry).toString('utf8'))
      bodyFromHtml = true
    }
  }

  return {
    ...(readString(file, top, TAG.subject) !== undefined
      ? { subject: readString(file, top, TAG.subject) }
      : {}),
    ...(() => {
      const name = readString(file, top, TAG.senderName) ?? readString(file, top, TAG.sentRepresentingName)
      const email = readString(file, top, TAG.senderEmail) ?? readString(file, top, TAG.sentRepresentingEmail)
      const from = [name, email !== undefined && email !== name ? `<${email}>` : undefined]
        .filter((part) => part !== undefined && part.length > 0)
        .join(' ')
      return from.length > 0 ? { from } : {}
    })(),
    ...(readString(file, top, TAG.displayTo) !== undefined
      ? { to: readString(file, top, TAG.displayTo) }
      : {}),
    ...(readString(file, top, TAG.displayCc) !== undefined
      ? { cc: readString(file, top, TAG.displayCc) }
      : {}),
    ...(readString(file, top, TAG.displayBcc) !== undefined
      ? { bcc: readString(file, top, TAG.displayBcc) }
      : {}),
    ...(() => {
      const sent = readTime(file, top, TAG.clientSubmitTime) ?? readTime(file, top, TAG.deliveryTime)
      return sent !== undefined ? { sent } : {}
    })(),
    body: (body ?? '').trim(),
    bodyFromHtml,
    attachments,
    recipients,
  }
}

/**
 * The message as text, with the headers a person would expect above it.
 *
 * Headers first and always, even when a field is missing, because "who was this from" is the
 * question somebody opens a saved message to answer. Attachments are **named**, not counted —
 * the same rule the approval prompts follow: a count hides which ones.
 */
export function renderMsg(parsed: ParsedMsg): string {
  const lines: string[] = []
  if (parsed.subject !== undefined) lines.push(`Subject: ${parsed.subject}`)
  if (parsed.from !== undefined) lines.push(`From: ${parsed.from}`)
  if (parsed.to !== undefined) lines.push(`To: ${parsed.to}`)
  if (parsed.cc !== undefined) lines.push(`Cc: ${parsed.cc}`)
  if (parsed.bcc !== undefined) lines.push(`Bcc: ${parsed.bcc}`)
  if (parsed.sent !== undefined) lines.push(`Sent: ${parsed.sent.toISOString()}`)
  if (parsed.attachments.length > 0) {
    lines.push(`Attachments: ${parsed.attachments.map((each) => each.name).join(', ')}`)
  }
  /*
   * Said once, where it matters. A body recovered from the HTML copy has lost its formatting -
   * and `mailFormat.ts` records that in work email the formatting is often the message, so a
   * reader should know which one they are looking at rather than assume.
   */
  if (parsed.bodyFromHtml) {
    lines.push('(no plain-text body in this message; the text below came from its HTML copy)')
  }
  lines.push('', parsed.body)
  return lines.join('\n')
}

export { CompoundFileError }
