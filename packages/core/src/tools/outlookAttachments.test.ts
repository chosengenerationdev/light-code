import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOutlookReadTool } from './office.js'

/** Reported: reading an email gave only attachment names. Now their content comes with it. */
let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true })
})

describe('reading an email with attachments', () => {
  it('returns the text of readable attachments, pictures as images, and says what it skipped', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-att-'))
    const csv = path.join(dir, '1-figures.csv')
    const png = path.join(dir, '2-chart.png')
    const bin = path.join(dir, '3-tool.exe')
    await fs.writeFile(csv, 'region,total\nnorth,42\n')
    await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await fs.writeFile(bin, Buffer.from([0, 1, 2]))
    let sent: Record<string, unknown> = {}
    const tool = createOutlookReadTool({
      bridge: {
        request: async (request: Record<string, unknown>) => {
          sent = request
          return {
            subject: 'Q3', from: 'Ann', fromAddress: 'ann@example.invalid', to: 'me', cc: '', received: '2026-10-01T09:00:00',
            body: 'See attached.', html: null, attachments: ['figures.csv', 'chart.png', 'tool.exe', 'huge.zip'],
            saved: [
              { name: 'figures.csv', size: 22, path: csv, skipped: null },
              { name: 'chart.png', size: 4, path: png, skipped: null },
              { name: 'tool.exe', size: 3, path: bin, skipped: null },
              { name: 'huge.zip', size: 90e6, path: null, skipped: 'larger than 25 MB' },
            ],
          }
        },
      },
    } as never)
    const result = await tool.execute({ entryId: 'abc' }, {} as never)
    expect(typeof sent.saveDir).toBe('string')
    expect(result.content).toContain('north,42')
    expect(result.content).toContain('chart.png (a picture, shown below)')
    expect(result.content).toContain('tool.exe (1 KB; not a format Light Code reads')
    expect(result.content).toContain('huge.zip (not read: larger than 25 MB)')
    expect(result.images?.map((i) => i.label)).toEqual(['chart.png'])
  })

  it('skips attachments when asked', async () => {
    let sent: Record<string, unknown> = {}
    const tool = createOutlookReadTool({
      bridge: { request: async (r: Record<string, unknown>) => ((sent = r), { subject: 's', from: 'a', fromAddress: 'b', to: 'c', cc: '', received: 'd', body: 'x', html: null, attachments: ['a.pdf'] }) },
    } as never)
    const result = await tool.execute({ entryId: 'abc', attachments: false }, {} as never)
    expect(sent.saveDir).toBeUndefined()
    expect(result.content).toContain('Attachments: a.pdf')
  })
})
