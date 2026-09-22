import { z } from 'zod'

import type { OfficeBridge } from '../office/bridge.js'
import { resolveToolPath } from './paths.js'
import type { Tool, ToolExecutionContext, ToolPreview, ToolResult } from './types.js'

/**
 * Composing a message in Outlook and putting it in front of the user. It never sends one.
 *
 * Requested in those terms: create the mail, attach or embed what it needs, fill in the
 * recipients that were given, show it, and let the person press Send.
 *
 * ## Why there is no send, not even behind a flag
 *
 * A parameter called `send` is one wrong argument away from a half-written message reaching a
 * distribution list, and the model generating that argument is the same one that wrote the
 * body. There is nothing to approve that would make it safe either: the approval prompt shows
 * ground truth about the *draft*, and a person reading a draft is exactly the check the feature
 * exists to provide. So `Send` appears nowhere in the worker, and `outlookDraft.test.ts`
 * asserts that by reading the script — the same habit `office.test.ts` applies to
 * `Invoke-Expression`.
 *
 * ## Why it is `command` and always asks
 *
 * It puts a window on somebody's screen, like `open_email`, and it does more than that one
 * does: it reads files off disk and puts their contents into a message. A category toggle
 * saying "auto-approve commands" is a statement about running commands, not about attaching
 * this machine's files to mail, so it is in `ALWAYS_ASK_TOOLS` and the preview lists every
 * recipient and every file by name rather than by count (invariant 8).
 *
 * ## Why the draft is not saved
 *
 * Displaying shows it without filing it, so closing the window offers to save and the person
 * decides. That is the same escape hatch the Excel tools keep by leaving a workbook dirty:
 * deciding against sending should not leave an item in Drafts behind every time.
 *
 * ## Why a scheduled run may still be granted it
 *
 * It is deliberately **not** in `NEVER_AVAILABLE_TO_SCHEDULES`. Everything on that list either
 * authorises a capability or changes state nobody will review — and this does neither. The
 * review is the feature: a draft sits there until a person reads it and sends it, so an
 * unattended run that composes one has not completed an action, it has prepared one. That is
 * much closer to `open_email` than to `excel_write_range`, and "draft the weekly report on
 * Friday" is exactly the job somebody would schedule. It still has to be ticked when the
 * schedule is written, which is a deliberate grant for one named job.
 *
 * ## Paths go through the ordinary gate
 *
 * `resolveToolPath` without `write`, so the deny list and confinement apply exactly as they do
 * to `read_file`, and a file outside the workspace prompts on its own terms. An attachment is a
 * read of that file by any reasonable reading, and giving mail its own rules would put a second
 * answer next to the one every other tool uses.
 */

const addresses = z
  .array(z.string().min(1))
  .max(100)
  .optional()

const paramsSchema = z.object({
  to: addresses.describe('Recipients. Email addresses, or names Outlook can resolve.'),
  cc: addresses.describe('Carbon-copy recipients.'),
  bcc: addresses.describe('Blind carbon-copy recipients.'),
  subject: z.string().max(500).optional().describe('Subject line.'),
  body: z
    .string()
    .max(200_000)
    .optional()
    .describe('The message body. Plain text unless html is true.'),
  html: z
    .boolean()
    .optional()
    .describe(
      'Treat body as HTML. Required if you are embedding images: refer to each one as ' +
        '<img src="cid:THE_CID"> using the cid you gave it in inlineImages.',
    ),
  attachments: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe('Files to attach, as paths. They appear as ordinary attachments.'),
  inlineImages: z
    .array(
      z.object({
        path: z.string().min(1).describe('The image file.'),
        cid: z
          .string()
          .min(1)
          .max(80)
          .regex(
            /^[A-Za-z0-9._-]+$/,
            'A cid may only contain letters, digits, dot, underscore and hyphen.',
          )
          .describe('The id your HTML refers to as cid:THIS.'),
      }),
    )
    .max(20)
    .optional()
    .describe(
      'Images shown inside the message rather than as attachments. Needs html: true and an ' +
        '<img src="cid:..."> in the body for each one.',
    ),
})

export type OutlookCreateDraftParams = z.infer<typeof paramsSchema>

interface DraftResult {
  displayed: boolean
  subject: string
  attached: string[]
  inline: string[]
  missing: string[]
  unresolved: string[]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every file the call names, in the order the preview should list them. */
function filesIn(params: OutlookCreateDraftParams): { path: string; inline: boolean }[] {
  return [
    ...(params.attachments ?? []).map((path) => ({ path, inline: false })),
    ...(params.inlineImages ?? []).map((image) => ({ path: image.path, inline: true })),
  ]
}

export function createOutlookDraftTool(options: { bridge: OfficeBridge }): Tool<OutlookCreateDraftParams> {
  return {
    name: 'outlook_create_draft',
    group: 'command',
    description:
      'Compose an email in the running Outlook and show it to the user, with recipients, ' +
      'subject, body, attachments and embedded images filled in. It is NEVER sent — it opens ' +
      'on screen and the user decides whether to send it, so write the message as if it is ' +
      'going out exactly as written. For an embedded image set html: true, list the file in ' +
      'inlineImages with a cid, and put <img src="cid:THAT_CID"> in the body; anything in ' +
      'attachments instead arrives as an ordinary attachment. Leave out recipients the user ' +
      'did not give you rather than guessing at them.',
    parametersSchema: paramsSchema,

    /**
     * Ground truth: who it is addressed to, what it says, and what is attached — by name.
     *
     * Every recipient listed rather than counted, for `open_email`'s reason: "send to 12
     * people" hides which twelve, and the recipient list is the part of a draft that does the
     * damage if it is wrong. The body is shown in full up to a limit, because the user is being
     * asked to approve putting *this text* in front of a colleague.
     */
    async preview(params): Promise<ToolPreview> {
      const lines: string[] = ['Compose a message in Outlook and show it to you. Nothing is sent.', '']

      const recipients: [string, string[] | undefined][] = [
        ['To', params.to],
        ['Cc', params.cc],
        ['Bcc', params.bcc],
      ]
      for (const [label, list] of recipients) {
        if (list !== undefined && list.length > 0) lines.push(`${label}: ${list.join(', ')}`)
      }
      if (params.to === undefined || params.to.length === 0) {
        lines.push('To: (nobody — you will fill this in)')
      }
      lines.push(`Subject: ${params.subject ?? '(none)'}`)

      const files = filesIn(params)
      if (files.length > 0) {
        lines.push('')
        lines.push('Files from this machine, put into the message:')
        for (const file of files) {
          lines.push(`  ${file.path}${file.inline ? '  (shown inside the message)' : ''}`)
        }
      }

      const body = params.body ?? ''
      lines.push('')
      lines.push(params.html === true ? 'Body (HTML):' : 'Body:')
      // Capped, and the truncation is stated. A body that scrolls past the prompt is one nobody
      // reads, but silently showing half of it would be worse than saying there is more.
      lines.push(body.length > 4000 ? `${body.slice(0, 4000)}\n…(${String(body.length - 4000)} more characters)` : body)

      return { kind: 'text', text: lines.join('\n') }
    },

    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      /*
       * Resolved here rather than in the worker, so a path gets the deny list, confinement and
       * the out-of-workspace prompt that every other file-reading tool applies. The worker is
       * handed real paths it has already been told are allowed.
       */
      const attachments: string[] = []
      const inlineImages: { path: string; cid: string }[] = []

      for (const file of params.attachments ?? []) {
        const resolved = await resolveToolPath(context, file)
        if (!resolved.ok) return { content: resolved.message, isError: true }
        attachments.push(resolved.realPath)
      }
      for (const image of params.inlineImages ?? []) {
        const resolved = await resolveToolPath(context, image.path)
        if (!resolved.ok) return { content: resolved.message, isError: true }
        inlineImages.push({ path: resolved.realPath, cid: image.cid })
      }

      if (params.html !== true && inlineImages.length > 0) {
        /*
         * Refused rather than quietly switched to HTML. An image cannot be embedded in a
         * plain-text message, so "helpfully" converting the body would turn text the model wrote
         * as prose into markup — every `<` and `&` in it silently changing meaning.
         */
        return {
          content:
            'Embedded images need html: true, and a plain-text body was given. Set html: true ' +
            'and write the body as HTML with an <img src="cid:..."> for each image, or move ' +
            'them to attachments to send them as ordinary attachments.',
          isError: true,
        }
      }

      try {
        const result = await options.bridge.request<DraftResult>({
          op: 'outlook.createDraft',
          ...(params.to !== undefined ? { to: params.to } : {}),
          ...(params.cc !== undefined ? { cc: params.cc } : {}),
          ...(params.bcc !== undefined ? { bcc: params.bcc } : {}),
          ...(params.subject !== undefined ? { subject: params.subject } : {}),
          ...(params.body !== undefined ? { body: params.body } : {}),
          ...(params.html !== undefined ? { html: params.html } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(inlineImages.length > 0 ? { inlineImages } : {}),
        })

        const lines = [
          `The draft is open in Outlook: "${result.subject.length > 0 ? result.subject : '(no subject)'}".`,
          'It has NOT been sent. The user sends it, or edits it first, or closes it.',
        ]
        if (result.attached.length > 0) lines.push(`Attached: ${result.attached.join(', ')}.`)
        if (result.inline.length > 0) lines.push(`Embedded in the body: ${result.inline.join(', ')}.`)
        if (result.missing.length > 0) {
          // Reported rather than thrown: the draft exists and is on screen, and failing the whole
          // call over one missing picture would throw away a message somebody can simply fix.
          lines.push(
            `Could not be found, so they are NOT in the message: ${result.missing.join(', ')}. ` +
              'Tell the user, since the draft is already open.',
          )
        }
        if (result.unresolved.length > 0) {
          /*
           * Named, because Outlook leaves an unresolved recipient in place looking correct and
           * refuses at send time — in front of whoever is sending. Better to say now.
           */
          lines.push(
            `Outlook could not resolve these recipients: ${result.unresolved.join(', ')}. ` +
              'They are still on the message. Check the spelling with the user, or they may ' +
              'simply be external addresses your address book has no entry for.',
          )
        }
        return { content: lines.join('\n') }
      } catch (error) {
        return { content: message(error), isError: true }
      }
    },
  }
}
