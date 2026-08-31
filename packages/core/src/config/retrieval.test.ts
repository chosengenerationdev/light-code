import { describe, expect, it } from 'vitest'

import { dispatcherEnabled, skillRetrievalEnabled } from './schema.js'
import { renderSkillsForPrompt, renderSkillsHintForPrompt, type Skill } from '../skills/index.js'
import { buildSystemPrompt } from '../agent/systemPrompt.js'
import { skillsForSchedule } from '../schedule/types.js'

/**
 * The defaults changed in 0.33.0 and the whole suite stayed green, which is its own finding:
 * nothing had ever asserted what they were. These pin both directions, so a future flip is a
 * deliberate edit rather than a silent one.
 */
describe('what is kept out of the prompt by default', () => {
  it('looks tools up rather than listing them, with no configuration at all', () => {
    expect(dispatcherEnabled(undefined)).toBe(true)
    expect(dispatcherEnabled({})).toBe(true)
  })

  it('does the same for skills', () => {
    expect(skillRetrievalEnabled(undefined)).toBe(true)
    expect(skillRetrievalEnabled({})).toBe(true)
  })

  it('is switched off by an explicit false, not by absence', () => {
    expect(dispatcherEnabled({ dispatcher: false })).toBe(false)
    expect(skillRetrievalEnabled({ skills: false })).toBe(false)
  })

  /**
   * `search_docs` is only registered when the dispatcher is on, so hiding skills without it
   * would make every skill permanently invisible — the model would be told notes exist and
   * given no way to reach them.
   */
  it('never hides skills when the thing that finds them is off', () => {
    expect(skillRetrievalEnabled({ dispatcher: false })).toBe(false)
    expect(skillRetrievalEnabled({ dispatcher: false, skills: true })).toBe(false)
  })
})

const skills: Skill[] = [
  { name: 'internal-http-client', description: 'How to call internal services.', filePath: '/w/.lightcode/skills/http.md' },
  { name: 'release-process', description: 'How a release is cut here.', filePath: '/w/.lightcode/skills/release.md' },
]

describe('the skills section of the prompt', () => {
  it('lists names, descriptions and paths when retrieval is off', () => {
    const rendered = renderSkillsForPrompt(skills)
    expect(rendered).toContain('internal-http-client')
    expect(rendered).toContain('How to call internal services.')
    expect(rendered).toContain('/w/.lightcode/skills/http.md')
  })

  /**
   * The point of the hint. A tool is looked up because the task obviously needs one; a skill's
   * one-line description is the only thing that makes the model aware the subject was ever
   * written about, so the count replaces that trigger rather than dropping it.
   */
  it('keeps a count and an instruction when retrieval is on, but no names', () => {
    const rendered = renderSkillsHintForPrompt(skills.length)
    expect(rendered).toContain('2')
    expect(rendered).toContain('search_docs')
    expect(rendered).not.toContain('internal-http-client')
    expect(rendered).not.toContain('release-process')
  })

  it('is very much shorter than the list it replaces, at scale', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      name: `skill-${String(index)}`,
      description: 'A reasonably wordy description of what this note is about, as they tend to be.',
      filePath: `/w/.lightcode/skills/skill-${String(index)}.md`,
    }))
    expect(renderSkillsHintForPrompt(many.length).length).toBeLessThan(renderSkillsForPrompt(many).length / 5)
  })

  /** Nothing to find means nothing to say about finding it. */
  it('says nothing at all when there are no skills', () => {
    expect(renderSkillsHintForPrompt(0)).toBe('')
    expect(renderSkillsForPrompt([])).toBe('')
  })

  it('uses singular wording for one skill', () => {
    expect(renderSkillsHintForPrompt(1)).toContain('1 note has')
    expect(renderSkillsHintForPrompt(2)).toContain('2 notes have')
  })
})

describe('the guidance for writing skills', () => {
  const build = (searchable: boolean): string =>
    buildSystemPrompt('/w', { canWriteSkills: true, skillsSearchable: searchable })

  /**
   * "Check the list above" is an instruction to consult something that is no longer there, and
   * following it means concluding no skill covers the subject without having looked — which
   * produces exactly the near-duplicate the bullet exists to prevent.
   */
  it('tells the model to search when there is no list to check', () => {
    const prompt = build(true)
    expect(prompt).toContain('search for one with search_docs')
    expect(prompt).not.toContain('check the list above')
  })

  it('tells it to check the list when the list is there', () => {
    const prompt = build(false)
    expect(prompt).toContain('check the list above')
    expect(prompt).not.toContain('search for one with search_docs')
  })

  /** The description is the retrieval key when skills are searched, not merely a summary. */
  it('says what the description line is for, differently in each mode', () => {
    expect(build(true)).toContain('what search matches on')
    expect(build(false)).toContain('the only part always in context')
  })
})

describe('which skills a scheduled run is told about', () => {
  /**
   * The upgrade case, and the one that must not regress: every schedule written before this
   * existed has no list, and reading that as "none" would quietly strip a working nightly job
   * of the conventions it was relying on.
   */
  it('includes all of them when the schedule has never said otherwise', () => {
    expect(skillsForSchedule(skills, undefined).map((skill) => skill.name)).toEqual([
      'internal-http-client',
      'release-process',
    ])
  })

  it('includes only the ones named', () => {
    expect(skillsForSchedule(skills, ['release-process']).map((skill) => skill.name)).toEqual(['release-process'])
  })

  /** Distinct from absent, and a legitimate choice for a run that needs no context. */
  it('treats an empty list as none, not as all', () => {
    expect(skillsForSchedule(skills, [])).toEqual([])
  })

  /**
   * A skill can be renamed or deleted long after a schedule was written. Failing a nightly job
   * over a stale name in a list of hints would be a poor trade.
   */
  it('drops a name that no longer resolves rather than failing', () => {
    expect(skillsForSchedule(skills, ['release-process', 'deleted-last-month']).map((s) => s.name)).toEqual([
      'release-process',
    ])
  })
})

/**
 * From a real session: asked to "create a tool to add 5 numbers", the model called
 * `write_to_file` and then `execute_command`, having no `create_python_tool` because the feature
 * was off. It produced a plain script and described it as a tool — true in English, false in this
 * product, and nothing anywhere said why.
 */
describe('when Python tools are switched off', () => {
  it('tells the model, so it offers the choice instead of substituting a script', () => {
    const prompt = buildSystemPrompt('/w', { pythonToolsDisabled: true })
    expect(prompt).toContain('Settings')
    expect(prompt).toContain('Python')
    expect(prompt).toContain('Do not write a script and call it a tool')
  })

  it('says nothing at all when they are available', () => {
    expect(buildSystemPrompt('/w', {})).not.toContain('Do not write a script and call it a tool')
    expect(buildSystemPrompt('/w', { pythonToolsDisabled: false })).not.toContain('switched off in Settings')
  })
})

/**
 * The regression this fixes: 0.31.0 put a guide button in the chat header unconditionally, and
 * `HostUi.openWalkthrough` is optional — so in the browser it posted a message nothing handled
 * and did nothing at all. Asking the host is the only honest way to know, since the capability
 * is precisely "did this host implement that method".
 */
describe('who owns the guide button', () => {
  const capability = (ui: { openWalkthrough?: () => Promise<void> }, mediaBase?: string) => ({
    nativeGuide: ui.openWalkthrough !== undefined,
    ...(mediaBase !== undefined ? { guideMediaBase: mediaBase } : {}),
  })

  it('is the host’s own onboarding when it has some', () => {
    expect(capability({ openWalkthrough: async () => undefined }).nativeGuide).toBe(true)
  })

  it('is the in-app tour when it does not', () => {
    expect(capability({}).nativeGuide).toBe(false)
  })

  /** No diagrams is a text tour, not fourteen broken images. */
  it('carries a media base only when the host serves one', () => {
    expect(capability({}, '/guide').guideMediaBase).toBe('/guide')
    expect(capability({}).guideMediaBase).toBeUndefined()
  })
})

/**
 * The default is `on`, and the way that breaks is not by being read wrongly — it is by not
 * being read at all.
 *
 * Two places in the bridge tested `retrieval?.dispatcher === true` directly. Written when the
 * default was off, both were correct at the time and both silently became wrong when it
 * flipped: a user who had never opened the setting had their tools hidden by one code path
 * and their documentation left unindexed by another, so `search_docs` could only match names.
 * Nothing errored, and the symptom — "it does not find my MCP tools" — points nowhere near
 * a boolean.
 *
 * So this asserts the *shape* rather than the behaviour: every decision goes through the one
 * function that owns the default.
 */
describe('the dispatcher default has one owner', () => {
  it('is never decided by reading the config key directly', async () => {
    const fs = await import('node:fs/promises')
    const url = await import('node:url')
    const bridge = url.fileURLToPath(new URL('../host/bridge.ts', import.meta.url))
    const source = await fs.readFile(bridge, 'utf8')

    // Comments explain the trap by naming it, so only real code is examined.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const direct = [...code.matchAll(/retrieval\?\.(dispatcher|skills)\s*[!=]==/g)].map((m) => m[0])

    expect(direct).toEqual([])
  })
})
