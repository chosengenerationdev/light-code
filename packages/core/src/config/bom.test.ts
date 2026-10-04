import { describe, expect, it } from 'vitest'

import { parseConfig } from './schema.js'

/** Notepad and Windows PowerShell start a UTF-8 file with a byte-order mark. */
describe('a config saved by Notepad or PowerShell', () => {
  it('reads a file that starts with a byte-order mark', () => {
    expect(parseConfig('\uFEFF{"activeProfileId":"local"}')).toEqual({ activeProfileId: 'local' })
  })
})
