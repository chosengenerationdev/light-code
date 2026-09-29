import { describe, expect, it } from 'vitest'

import { fillAttribution, missingAttribution, readAttribution, stampRevision } from './attribution.js'

/**
 * Author, project, version and time of the last save, carried inside skills and Python tools so a
 * bucket and a cluster shared by several teams can say what belongs to whom.
 */

const NOW = new Date('2026-09-29T08:15:02.345Z')
const SKILL = '---\nname: deploy\ndescription: How we deploy\n---\n\nSteps.\n'

describe('skills', () => {
  it('labels a new skill with author, project, version 1 and the time', () => {
    const stamped = stampRevision('skill', SKILL, undefined, { author: 'ana', project: 'Payments' }, NOW)
    expect(stamped).toBe(
      '---\nname: deploy\ndescription: How we deploy\nauthor: ana\nproject: Payments\nversion: 1\nupdated: 2026-09-29T08:15:02Z\n---\n\nSteps.\n',
    )
  })

  it('keeps the original author and project on an update, and moves the version on', () => {
    const first = stampRevision('skill', SKILL, undefined, { author: 'ana', project: 'Payments' }, NOW)
    // The model rewrites the skill without the labels; somebody else saves it.
    const second = stampRevision('skill', SKILL, first, { author: 'bo', project: 'Other' }, new Date('2026-10-01T00:00:00Z'))
    expect(readAttribution('skill', second)).toEqual({ author: 'ana', project: 'Payments', version: 2, updated: '2026-10-01T00:00:00Z' })
  })

  it('counts a skill saved before versions existed as version 1', () => {
    expect(readAttribution('skill', stampRevision('skill', SKILL, SKILL, {}, NOW)).version).toBe(2)
  })

  /*
   * An unlabelled existing skill may be a colleague's, copied in or synced from a shared bucket.
   * Whoever saves it next is not evidence of who wrote it.
   */
  it('never guesses the author or project of an existing unlabelled skill on save', () => {
    const saved = readAttribution('skill', stampRevision('skill', SKILL, SKILL, { author: 'ana', project: 'Payments' }, NOW))
    expect(saved).toEqual({ author: undefined, project: undefined, version: 2, updated: '2026-09-29T08:15:02Z' })
  })

  it('fills only what is missing when labelling an existing file', () => {
    const colleague = '---\nname: deploy\ndescription: d\nauthor: chen\n---\nbody'
    const filled = fillAttribution('skill', colleague, { author: 'ana', project: 'Payments', version: 1, updated: '2026-01-01T00:00:00Z' })
    expect(readAttribution('skill', filled)).toEqual({ author: 'chen', project: 'Payments', version: 1, updated: '2026-01-01T00:00:00Z' })
    expect(missingAttribution('skill', filled)).toEqual([])
  })

  it('cannot break out of the frontmatter', () => {
    const stamped = stampRevision('skill', SKILL, undefined, { author: 'ana\n---\nname: evil' }, NOW)
    expect(readAttribution('skill', stamped).author).toBe('ana---name: evil')
    expect(stamped.match(/^---$/gm)).toHaveLength(2)
  })
})

describe('python tools', () => {
  const TOOL = [
    '#!/usr/bin/env python',
    '# /// script',
    '# dependencies = ["httpx"]',
    '# ///',
    '"""Fetch a ledger.',
    '',
    'Args:',
    '    day: which day',
    '"""',
    'from __future__ import annotations',
    '',
    'import httpx',
    '',
    'def run(day: str) -> str:',
    '    return day',
    '',
  ].join('\n')

  it('goes after the docstring and __future__ imports, so neither stops working', () => {
    const stamped = stampRevision('tool', TOOL, undefined, { author: 'ana', project: 'Payments' }, NOW)
    const lines = stamped.split('\n')
    expect(lines.indexOf('from __future__ import annotations')).toBeLessThan(lines.indexOf('__author__ = "ana"'))
    expect(lines[4]).toBe('"""Fetch a ledger.')
    expect(stamped).toContain('__author__ = "ana"\n__project__ = "Payments"\n__version__ = "1"\n__updated__ = "2026-09-29T08:15:02Z"\n\nimport httpx')
  })

  it('bumps the version and time in place on the next save', () => {
    const first = stampRevision('tool', TOOL, undefined, { author: 'ana', project: 'Payments' }, NOW)
    const edited = first.replace('return day', 'return day.upper()')
    const second = stampRevision('tool', edited, first, { author: 'bo' }, new Date('2026-10-01T00:00:00Z'))
    expect(readAttribution('tool', second)).toEqual({ author: 'ana', project: 'Payments', version: 2, updated: '2026-10-01T00:00:00Z' })
    expect(second.match(/__version__/g)).toHaveLength(1)
  })

  it('leaves a computed __version__ alone, since that is somebody\'s code', () => {
    const computed = 'import pkg\n__version__ = pkg.VERSION\n\ndef run() -> str:\n    return ""\n'
    const stamped = stampRevision('tool', computed, undefined, { author: 'ana' }, NOW)
    expect(stamped).toContain('__version__ = pkg.VERSION')
    expect(stamped.match(/__version__/g)).toHaveLength(1)
  })

  it('handles a file with no docstring', () => {
    const stamped = fillAttribution('tool', 'import os\n\ndef run() -> str:\n    return os.sep\n', { author: 'ana', version: 1 })
    expect(stamped.startsWith('__author__ = "ana"\n__version__ = "1"\n\nimport os')).toBe(true)
  })
})
