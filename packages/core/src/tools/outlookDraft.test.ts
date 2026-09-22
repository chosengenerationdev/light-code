import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { PathDenylist } from '../fs/denylist.js'
import type { OfficeBridge } from '../office/bridge.js'
import { OFFICE_WORKER_SOURCE } from '../office/workerSource.js'
import { createOutlookDraftTool } from './outlookDraft.js'
import type { ToolExecutionContext } from './types.js'

/**
 * Drafting a message, and the one property the whole feature rests on: it cannot send.
 */

function fakeBridge(reply: unknown): OfficeBridge & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = []
  return {
    requests,
    async request(payload: Record<string, unknown>) {
      requests.push(payload)
      return reply
    },
  } as unknown as OfficeBridge & { requests: Record<string, unknown>[] }
}

const context = (root: string): ToolExecutionContext =>
  ({ workspaceRoot: root, denylist: new PathDenylist() }) as unknown as ToolExecutionContext

/*
 * A root that exists on disk. `resolveToolPath` realpaths before comparing, so an invented one
 * would fail containment for the wrong reason and every "it refused" assertion would pass
 * whatever the code did.
 */
const ROOT = process.cwd()
/** A file that genuinely exists, so a resolution failure means what the test says it means. */
const REAL_FILE = path.relative(ROOT, path.join(import.meta.dirname, 'outlookDraft.ts'))

const reply = {
  displayed: true,
  subject: 'Weekly report',
  attached: ['report.xlsx'],
  inline: [],
  missing: [],
  unresolved: [],
}

describe('the worker cannot send mail', () => {
  it('has no Send call anywhere in it', () => {
    /*
     * Read from the generated script rather than reasoned about, the way `office.test.ts` pins
     * the absence of `Invoke-Expression`. This is the entire safety argument of the feature:
     * the user asked for a draft they press Send on themselves, so there must be no path -
     * flag, parameter or otherwise - by which the assistant sends it.
     */
    expect(OFFICE_WORKER_SOURCE).not.toMatch(/\.Send\(/)
    expect(OFFICE_WORKER_SOURCE).not.toMatch(/\bolSend\b/)
  })

  it('does not file the draft either, so closing it is the way out', () => {
    // `Display` and no `Save`: deciding against sending must not leave an item in Drafts. The
    // same escape hatch the Excel tools keep by leaving a workbook dirty.
    const routine = OFFICE_WORKER_SOURCE.slice(
      OFFICE_WORKER_SOURCE.indexOf('function Invoke-OutlookCreateDraft'),
      OFFICE_WORKER_SOURCE.indexOf('function Invoke-OutlookDisplay'),
    )
    expect(routine).toContain('$mail.Display($false)')
    expect(routine).not.toContain('$mail.Save()')
  })

  it('attaches before it writes the body, or an embedded image renders broken', () => {
    const routine = OFFICE_WORKER_SOURCE.slice(
      OFFICE_WORKER_SOURCE.indexOf('function Invoke-OutlookCreateDraft'),
      OFFICE_WORKER_SOURCE.indexOf('function Invoke-OutlookDisplay'),
    )
    // The content id has to exist before the HTML that refers to it is set, or Outlook holds a
    // body whose img tags resolve to nothing — which looks like the picture failing to attach.
    expect(routine.indexOf('0x3712001F')).toBeLessThan(routine.indexOf('$mail.HTMLBody = $body'))
  })
})

describe('outlook_create_draft', () => {
  it('always asks, whatever is auto-approved', () => {
    // It reads files off this machine and addresses them to other people. "Auto-approve
    // commands" is not permission for that.
    expect(ALWAYS_ASK_TOOLS.has('outlook_create_draft')).toBe(true)
  })

  it('names every recipient and every file in the preview, never a count', () => {
    const tool = createOutlookDraftTool({ bridge: fakeBridge(reply) })
    const preview = tool.preview?.(
      {
        to: ['ana@example.com', 'ben@example.com'],
        cc: ['carol@example.com'],
        bcc: ['dan@example.com'],
        subject: 'Weekly report',
        body: 'Attached.',
        attachments: ['reports/march.xlsx'],
      },
      context(ROOT),
    )
    return preview?.then((shown) => {
      expect(shown.kind).toBe('text')
      const text = shown.kind === 'text' ? shown.text : ''
      // Invariant 8: "send to 4 people" hides which four, and the recipient list is the part
      // of a draft that does the damage when it is wrong.
      expect(text).toContain('ana@example.com')
      expect(text).toContain('ben@example.com')
      expect(text).toContain('carol@example.com')
      expect(text).toContain('dan@example.com')
      expect(text).toContain('reports/march.xlsx')
      expect(text).toContain('Nothing is sent')
    })
  })

  it('says so when nothing is addressed, rather than showing an empty To line', async () => {
    const tool = createOutlookDraftTool({ bridge: fakeBridge(reply) })
    const shown = await tool.preview?.({ subject: 'Draft' }, context(ROOT))
    expect(shown?.kind === 'text' ? shown.text : '').toContain('you will fill this in')
  })

  it('refuses an embedded image in a plain-text body instead of converting it', async () => {
    /*
     * Switching the body to HTML "helpfully" would reinterpret text the model wrote as prose:
     * every `<` and `&` in it silently changes meaning, and the user approves one thing and
     * receives another.
     */
    const tool = createOutlookDraftTool({ bridge: fakeBridge(reply) })
    const result = await tool.execute(
      { body: 'see below', inlineImages: [{ path: REAL_FILE, cid: 'pic1' }] },
      context(ROOT),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('html: true')
  })

  it('hands the worker resolved absolute paths, not what the model typed', async () => {
    // So the deny list and confinement have already been applied by the time anything is
    // attached — the same gate `read_file` goes through.
    const bridge = fakeBridge(reply)
    const tool = createOutlookDraftTool({ bridge })
    await tool.execute({ to: ['ana@example.com'], attachments: [REAL_FILE] }, context(ROOT))

    const sent = bridge.requests[0]
    expect(sent?.op).toBe('outlook.createDraft')
    expect((sent?.attachments as string[])[0]).toBe(
      path.resolve(ROOT, REAL_FILE),
    )
  })

  it('refuses a path outside the workspace rather than attaching it', async () => {
    const bridge = fakeBridge(reply)
    const tool = createOutlookDraftTool({ bridge })
    const result = await tool.execute(
      { to: ['ana@example.com'], attachments: ['../../../etc/hosts'] },
      context(ROOT),
    )
    expect(result.isError).toBe(true)
    // Nothing reached Outlook.
    expect(bridge.requests).toHaveLength(0)
  })

  it('reports a missing file without throwing away the draft that is already open', async () => {
    /*
     * The window is on screen by the time the worker answers. Failing the whole call over one
     * missing picture would report that nothing happened when something did.
     */
    const bridge = fakeBridge({ ...reply, missing: ['logo.png'], attached: [] })
    const tool = createOutlookDraftTool({ bridge })
    const result = await tool.execute({ to: ['ana@example.com'] }, context(ROOT))
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('logo.png')
    expect(result.content).toContain('NOT been sent')
  })

  it('names recipients Outlook could not resolve', async () => {
    // Outlook leaves one in place looking correct and refuses at send time, in front of
    // whoever is sending.
    const bridge = fakeBridge({ ...reply, unresolved: ['ben smithe'] })
    const tool = createOutlookDraftTool({ bridge })
    const result = await tool.execute({ to: ['ben smithe'] }, context(ROOT))
    expect(result.content).toContain('ben smithe')
    expect(result.content).toContain('still on the message')
  })
})
