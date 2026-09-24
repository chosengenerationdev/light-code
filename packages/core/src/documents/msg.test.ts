import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { CompoundFile, isCompoundFile } from './cfbf.js'
import { parseMsg, renderMsg } from './msg.js'

/**
 * Reading a saved Outlook message.
 *
 * Reported: *"light couldn't read the outlook msg file"*. It could not, and it failed in the
 * worst available way — a `.msg` is a compound file, so it fell through to being decoded as
 * UTF-8 and came back as mojibake with fragments of real text in it. `pdf.ts` refuses to return
 * glyph soup for exactly that reason, because a model handed fragments summarises them
 * confidently.
 *
 * **The fixture is a real compound file, and that is checked by somebody else.** It is written by
 * `scratchpad/make_msg.py` and read back there with `olefile` — a third-party implementation of
 * the same format — which confirms the signature, the directory and the stream contents before it
 * is committed. A fixture produced by the code under test would agree with that code whatever
 * either of them did.
 */

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'reconciliation.msg')
const buffer = (): Buffer => fs.readFileSync(FIXTURE)

describe('the compound file underneath', () => {
  it('recognises the signature', () => {
    expect(isCompoundFile(buffer())).toBe(true)
    expect(isCompoundFile(Buffer.from('not a compound file'))).toBe(false)
  })

  it('finds the streams a message keeps at the top level', () => {
    const file = new CompoundFile(buffer())
    const names = file.childrenOf(0).map((entry) => entry.name)
    expect(names).toContain('__substg1.0_0037001F')
    expect(names).toContain('__attach_version1.0_#00000000')
  })

  it('reads a stream out of the mini stream, where a subject actually lives', () => {
    /*
     * The part of this format readers get wrong. A subject is far under the 4096-byte cutoff, so
     * it sits in the mini stream chained by the mini FAT - and a reader that only understood
     * ordinary sectors would return nothing for the one field everybody wants, and look like it
     * had worked.
     */
    const file = new CompoundFile(buffer())
    const subject = file.childrenOf(0).find((entry) => entry.name === '__substg1.0_0037001F')
    expect(subject).toBeDefined()
    expect(file.read(subject as never).toString('utf16le')).toBe('Quarter-end reconciliation')
  })

  it('refuses something that is not one, rather than reading rubbish', () => {
    expect(() => new CompoundFile(Buffer.alloc(1024))).toThrow(/not a compound file/)
  })

  it('refuses a truncated header', () => {
    expect(() => new CompoundFile(buffer().subarray(0, 64))).toThrow(/too short/)
  })
})

describe('parseMsg', () => {
  it('reads the headers somebody opens a saved message to see', () => {
    const parsed = parseMsg(buffer())
    expect(parsed.subject).toBe('Quarter-end reconciliation')
    expect(parsed.from).toContain('Priya Raman')
    expect(parsed.from).toContain('priya.raman@example.com')
    expect(parsed.to).toBe('Alex Whitfield; Sam Okonkwo')
    expect(parsed.cc).toBe('Reporting Team')
  })

  it('reads the body as text rather than as bytes', () => {
    const parsed = parseMsg(buffer())
    expect(parsed.body).toContain('The reconciliation finished overnight.')
    expect(parsed.bodyFromHtml).toBe(false)
    // The failure this replaces: a UTF-8 decode of the container, which is mostly NULs.
    expect(parsed.body).not.toContain('\u0000')
  })

  it('decodes the sent time from a FILETIME', () => {
    // 100-nanosecond ticks since 1601, which is off by 11644473600 seconds if you forget.
    const parsed = parseMsg(buffer())
    expect(parsed.sent?.toISOString()).toBe(new Date(1_750_000_000_000).toISOString())
  })

  it('names the attachments rather than counting them', () => {
    // The rule the approval prompts follow: a count hides which ones.
    const parsed = parseMsg(buffer())
    expect(parsed.attachments.map((each) => each.name)).toEqual(['reconciliation-q3.xlsx'])
  })

  it('reads the recipient storages, which are separate from the display headers', () => {
    const parsed = parseMsg(buffer())
    expect(parsed.recipients[0]?.name).toBe('Alex Whitfield')
    expect(parsed.recipients[0]?.email).toBe('alex.whitfield@example.com')
  })
})

describe('renderMsg', () => {
  it('puts the headers above the body', () => {
    const text = renderMsg(parseMsg(buffer()))
    expect(text.startsWith('Subject: Quarter-end reconciliation')).toBe(true)
    expect(text).toContain('From: Priya Raman')
    expect(text).toContain('Attachments: reconciliation-q3.xlsx')
    expect(text).toContain('The reconciliation finished overnight.')
  })

  it('says when the text came from the HTML copy', () => {
    /*
     * `office/mailFormat.ts` records that in work email the formatting is often the message - the
     * red line is the failure. A body recovered from HTML has lost all of it, so the reader is
     * told which one they are looking at rather than left to assume.
     */
    const text = renderMsg({
      body: 'recovered',
      bodyFromHtml: true,
      attachments: [],
      recipients: [],
    })
    expect(text).toContain('came from its HTML copy')
  })
})
