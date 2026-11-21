import { describe, expect, it } from 'vitest'

import { shortenPaths } from './startupPaths.js'

/** Reported: the startup bar showed whole temp paths of the skills and tools folders, taking room above the message box. */
describe('paths in the startup bar', () => {
  it('keeps the last two parts of a Windows, UNC or POSIX path, and leaves short ones alone', () => {
    expect(shortenPaths('reading C:\\Users\\me\\AppData\\Local\\light-code\\s3\\main\\skills-1a2b3c')).toBe('reading …\\main\\skills-1a2b3c')
    expect(shortenPaths('reading tools in \\\\server\\share\\team\\tools')).toBe('reading tools in …\\team\\tools')
    expect(shortenPaths('reading /home/me/.cache/light-code/skills')).toBe('reading …/light-code/skills')
    expect(shortenPaths('reading D:\\skills')).toBe('reading D:\\skills')
    expect(shortenPaths('checking for uv')).toBe('checking for uv')
  })
})
