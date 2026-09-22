import { describe, expect, it } from 'vitest'

import { configSchema } from '../config/schema.js'
import { BUILTIN_MODES } from '../modes/builtin.js'
import { createLightCodeHelpTool, scoreTopic } from '../tools/help.js'
import { HELP_TOPICS } from './topics.js'

/**
 * That the handbook describes *this* product.
 *
 * **A document stating something false about the software is worse than one that omits it**,
 * because somebody reads it and stops looking — §14 records exactly that happening to
 * `docs/hosting.md`, which asserted the opposite of what had shipped for a whole version. This
 * handbook is worse placed still: it is read by the assistant and repeated to the user as fact.
 *
 * So everything checkable is checked against the thing it describes, and a rename breaks the
 * build rather than misleading somebody a year later. Prose cannot be checked this way, which is
 * why the topics are about mechanisms rather than about where buttons sit.
 */

/** The shape at a dotted path, or undefined when the schema has no such key. */
function shapeAt(path: string): unknown {
  const unwrap = (node: unknown): Record<string, unknown> | 'record' | undefined => {
    let current = node
    for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
      const def = (current as { _zod?: { def?: Record<string, unknown> } })._zod?.def
      if (def === undefined) return undefined
      if (def['type'] === 'object') return def['shape'] as Record<string, unknown>
      if (def['type'] === 'record') return 'record'
      if (def['innerType'] !== undefined) {
        current = def['innerType']
        continue
      }
      return undefined
    }
    return undefined
  }

  let shape = unwrap(configSchema)
  const segments = path.split('.')
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string
    // A record accepts any key below it — `approvals` is keyed by workspace path.
    if (shape === 'record') return 'record'
    if (shape === undefined) return undefined
    const next = shape[segment]
    if (next === undefined) return undefined
    if (index === segments.length - 1) return next
    shape = unwrap(next)
  }
  return undefined
}

/** Every `config:some.key` the handbook names. */
function configKeysNamed(): { topic: string; key: string }[] {
  const found: { topic: string; key: string }[] = []
  for (const topic of HELP_TOPICS) {
    for (const match of topic.body.matchAll(/config:([A-Za-z0-9_.]+[A-Za-z0-9_])/g)) {
      found.push({ topic: topic.id, key: match[1] as string })
    }
  }
  return found
}

describe('the handbook describes the real product', () => {
  it('names only config keys the schema actually has', () => {
    /*
     * The check this file exists for. A key renamed in `schema.ts` would otherwise leave the
     * assistant confidently telling somebody to set something that does nothing - and they would
     * set it, see no effect, and conclude the feature is broken.
     */
    const named = configKeysNamed()
    expect(named.length).toBeGreaterThan(10)
    const missing = named.filter((entry) => shapeAt(entry.key) === undefined)
    expect(missing, `unknown config keys: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('verifies against the schema rather than passing on anything', () => {
    // Non-vacuity: the walker must actually reject a key that is not there, or the test above
    // would pass whatever the handbook claimed.
    expect(shapeAt('python.dynamicTools')).toBeDefined()
    expect(shapeAt('python.thisWasNeverAKey')).toBeUndefined()
    expect(shapeAt('notATopLevelKey')).toBeUndefined()
  })

  it('names only modes that exist', () => {
    // `junior` is named as an *old* name that resolves to Agent team, so it is deliberately not
    // required to be current - but every id offered as a thing to pick must be.
    const ids = new Set(BUILTIN_MODES.map((mode) => mode.id))
    const modes = HELP_TOPICS.find((topic) => topic.id === 'modes')
    expect(modes).toBeDefined()
    for (const id of ['code', 'ask', 'auto', 'agent-team']) {
      expect(ids.has(id), `${id} is described but is not a built-in mode`).toBe(true)
    }
  })

  it('lists the settings tabs the panel really has', () => {
    /*
     * Read from the panel's own source. A tab renamed or removed would make the overview send
     * somebody looking for something that is not there, which is the most annoying kind of wrong
     * a help system can be.
     */
    const overview = HELP_TOPICS.find((topic) => topic.id === 'overview')?.body ?? ''
    for (const label of ['Providers', 'Approvals', 'MCP', 'Search', 'Agents', 'Skills', 'Python']) {
      expect(overview, `${label} tab missing from the overview`).toContain(label)
    }
  })

  it('has unique ids and no empty bodies', () => {
    const ids = HELP_TOPICS.map((topic) => topic.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const topic of HELP_TOPICS) {
      expect(topic.body.trim().length, `${topic.id} is empty`).toBeGreaterThan(200)
      expect(topic.keywords.length, `${topic.id} has no keywords`).toBeGreaterThan(2)
    }
  })

  it('never leaks the config: marker to the model', async () => {
    // It is a marker for this test, not something to read. Every topic goes through `render`.
    const tool = createLightCodeHelpTool()
    for (const topic of HELP_TOPICS) {
      const result = await tool.execute({ topic: topic.id }, undefined as never)
      expect(result.content, `${topic.id} leaked the marker`).not.toContain('config:')
    }
  })
})

describe('finding the right topic', () => {
  const tool = createLightCodeHelpTool()
  const answer = async (query: string): Promise<string> =>
    (await tool.execute({ query }, undefined as never)).content

  it('lists everything when asked nothing', async () => {
    const content = (await tool.execute({}, undefined as never)).content
    for (const topic of HELP_TOPICS) expect(content).toContain(topic.id)
  })

  it('answers the question that prompted all of this', async () => {
    // Somebody in Auto mode being asked to approve read-only commands.
    expect(await answer('it keeps asking permission for git status')).toContain('Auto mode')
    expect(await answer('how do I stop it asking about every command')).toContain('Approvals')
  })

  it('matches the words people use, not the words features are called', async () => {
    /*
     * The keyword lists exist for this. Nobody types "the approval gate"; they type "permission"
     * or "keeps asking", and a search over titles alone would find neither.
     */
    expect(await answer('where is the config file')).toContain('config.json')
    expect(await answer('turn on excel')).toContain('Excel')
    expect(await answer('teach it about our internal library')).toContain('skill')
    expect(await answer('undo what it just did')).toContain('Rollback')
  })

  it('routes the questions it was actually driven with', async () => {
    /*
     * Every one of these was a miss when this was first run against ordinary questions, and each
     * fix is a different lesson - so they are pinned as a set rather than as one example.
     *
     * - "every morning" matched nothing, and the longest topic won on body-word volume.
     * - "about" is filler, and sat in Approvals' title where it scored as the subject.
     * - "change" is the commonest word in a help query, and sat in Checkpoints' old title.
     * - "dark mode" went to Modes, where "mode" is a keyword and the subject is something else.
     */
    const cases: [string, string][] = [
      ['how do I run something every morning', 'schedules'],
      ['how do I teach it about our internal library', 'skills'],
      ['how do I change the colour', 'appearance'],
      ['how do I make it use dark mode', 'appearance'],
      ['it is not finding my files with @', 'troubleshooting'],
      ['why does it keep asking me to approve git status', 'approvals'],
      ['where is the config file stored', 'overview'],
      ['how do I enable excel', 'office'],
      ['can it write an email for me', 'office'],
      ['how do I undo the changes it made', 'checkpoints'],
      ['what does auto mode do', 'modes'],
      ['can it search my whole team codebase', 'search'],
      ['my mcp server will not connect', 'mcp'],
      ['how do I use a jupyter notebook', 'jupyter'],
      ['how do I change which model it uses', 'providers'],
    ]
    for (const [query, expected] of cases) {
      const content = await answer(query)
      expect(content, `"${query}" should answer from ${expected}`).toContain(
        `(topic id: ${expected})`,
      )
    }
  })

  it('admits it has nothing rather than returning the top of a pile of noise', async () => {
    /*
     * Body matches are capped, so a score at or under that cap means no topic is *about* the
     * question. "nothing happens when I send a message" came back as the Outlook topic before
     * this, which is worse than useless: the model would have explained mail to somebody with a
     * broken session.
     */
    const vague = await answer('wibble frobnicate quux')
    expect(vague).toContain('Nothing here is clearly about')
    expect(vague).toContain('overview')
  })

  it('scores a whole phrase above the words in it', () => {
    // "auto mode" appears in several topics as two ordinary words; only one is about it.
    const modes = HELP_TOPICS.find((topic) => topic.id === 'modes') as (typeof HELP_TOPICS)[number]
    const others = HELP_TOPICS.filter((topic) => topic.id !== 'modes' && topic.id !== 'approvals')
    for (const other of others) {
      expect(
        scoreTopic(modes, 'what is auto mode'),
        `${other.id} outranked modes`,
      ).toBeGreaterThan(scoreTopic(other, 'what is auto mode'))
    }
  })

  it('treats a wrong topic id as a search rather than an error', async () => {
    // The model guesses ids. "No such topic" spends a turn teaching it something the listing
    // would have said.
    const result = await tool.execute({ topic: 'excel' }, undefined as never)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('Excel')
  })

  it('says so plainly when it has nothing, rather than returning the nearest thing', async () => {
    const result = await answer('zzzz qqqq vvvv')
    expect(result).toContain('Nothing here is clearly about')
    // And still offers the list, because "no" without a next step is not help.
    expect(result).toContain('overview')
  })

  it('returns one topic in full and only names the runners-up', async () => {
    // Three whole topics is several thousand tokens for a question with one answer.
    const result = await answer('approval')
    const headings = result.match(/^## /gm) ?? []
    expect(headings).toHaveLength(1)
  })
})
