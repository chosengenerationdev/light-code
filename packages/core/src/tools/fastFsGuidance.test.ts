import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFastFsTools, fastFsGuidance } from './fastFs.js'

/**
 * Reported: the Rust tools were registered and the model still did not use them until reminded. The
 * prompt now says which job each is for; these keep that true as tools are added.
 */
describe('the fast file tools are introduced to the model', () => {
  it('names every one of them', () => {
    const guidance = fastFsGuidance()
    for (const tool of createFastFsTools('fire-fs.exe')) expect(guidance, tool.name).toContain(tool.name)
  })

  it('is put into the prompt whenever the host supplies the helper', async () => {
    const bridge = await fs.readFile(path.join(import.meta.dirname, '..', 'host', 'bridge.ts'), 'utf8')
    expect(bridge).toMatch(/if \(services\.fastFs !== undefined\) parts\.push\(fastFsGuidance\(\)\)/)
  })
})
