import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildSystemPrompt } from '../agent/systemPrompt.js'
import { ASK_MODE, BUILTIN_MODES, CODE_MODE, findMode, JUNIOR_MODE } from '../modes/builtin.js'
import type { Skill } from '../skills/index.js'
import type { Tool } from '../tools/types.js'
import { createAskExpertTool } from '../tools/askExpert.js'
import type { ToolExecutionContext } from '../tools/types.js'
import { buildExpertBriefing } from './briefing.js'

function tool(name: string, description: string): Tool {
  return { name, group: 'read', description, parametersSchema: z.object({}), execute: async () => ({ content: '' }) }
}

function skill(name: string, description: string): Skill {
  return { name, description, filePath: `/ws/.lightcode/skills/${name}.md` }
}

describe('Junior mode', () => {
  it('is offered, and needs the expert', () => {
    expect(BUILTIN_MODES).toContain(JUNIOR_MODE)
    expect(findMode('junior')).toBe(JUNIOR_MODE)
    expect(JUNIOR_MODE.requiresExpert).toBe(true)
  })

  /** It is the hands: it has to be able to edit and run things, unlike Ask mode. */
  it('keeps every tool group, because the junior does the work', () => {
    expect(JUNIOR_MODE.groups).toEqual(CODE_MODE.groups)
  })

  /**
   * The guidance exists to *ration* consultations, not encourage them — a junior that
   * consults per step costs more than not having the mode at all. These assert the two rules
   * that decide that, so a future reword cannot quietly drop them.
   */
  it('tells the junior to consult once and not to repeat context', () => {
    const guidance = JUNIOR_MODE.guidance ?? ''
    expect(guidance).toMatch(/consult once/i)
    expect(guidance).toMatch(/remembers/i)
    expect(guidance).toMatch(/failed twice/i)
  })

  it('warns that the expert cannot call the junior tools', () => {
    expect(JUNIOR_MODE.guidance ?? '').toMatch(/cannot call any of your tools/i)
  })

  it('carries no guidance on the other modes, so their prompts are unchanged', () => {
    expect(CODE_MODE.guidance).toBeUndefined()
    expect(ASK_MODE.guidance).toBeUndefined()
  })
})

describe('mode guidance in the system prompt', () => {
  it('is appended last, so a mode can narrow what came before it', () => {
    const prompt = buildSystemPrompt('/ws', { expertAvailable: true, modeGuidance: 'MODE-RULES-HERE' })
    expect(prompt).toContain('MODE-RULES-HERE')
    expect(prompt.indexOf('MODE-RULES-HERE')).toBeGreaterThan(prompt.indexOf('Expert consultation'))
  })

  it('changes nothing when absent', () => {
    expect(buildSystemPrompt('/ws')).toBe(buildSystemPrompt('/ws', { modeGuidance: '' }))
  })
})

describe('the expert briefing', () => {
  const promptTools = [tool('read_file', 'Read a file from the workspace.'), tool('apply_diff', 'Edit a file.')]

  it('states plainly that the expert cannot run or call anything', () => {
    const briefing = buildExpertBriefing({ promptTools })
    expect(briefing).toMatch(/you are read-only/i)
    expect(briefing).toMatch(/tell the junior to/i)
  })

  it('lists dispatch-only tools alongside advertised ones', () => {
    const briefing = buildExpertBriefing({
      promptTools,
      dispatchOnlyTools: [tool('s3__get_object', 'Download an object from bucket storage.')],
    })
    expect(briefing).toContain('s3__get_object')
    expect(briefing).toContain('read_file')
    expect(briefing).toContain('Tools the junior can call (3)')
  })

  /**
   * The point of the whole arrangement: names are cheap, schemas are not. Forty tools as a
   * list costs a few hundred tokens; as JSON Schema it is thousands, on a model priced for
   * thinking rather than reading.
   */
  it('never includes a parameter schema', () => {
    const withParams: Tool = {
      name: 'srv__thing',
      group: 'read',
      description: 'Does a thing.',
      parametersSchema: z.object({ veryDistinctiveParamName: z.string() }),
      execute: async () => ({ content: '' }),
    }
    const briefing = buildExpertBriefing({ promptTools: [withParams] })
    expect(briefing).not.toContain('veryDistinctiveParamName')
    expect(briefing).not.toContain('properties')
    expect(briefing).toMatch(/do not guess/i)
  })

  it('points at search_docs for exact arguments when retrieval exists', () => {
    expect(buildExpertBriefing({ promptTools, retrievalAvailable: true })).toContain('search_docs')
    expect(buildExpertBriefing({ promptTools, retrievalAvailable: false })).not.toContain('search_docs')
  })

  /** A server description can run to a paragraph; forty of those defeats the purpose. */
  it('clips a long description to its first line', () => {
    const briefing = buildExpertBriefing({
      promptTools: [tool('verbose', `Short summary.\nThen a second line that should not appear.`)],
    })
    expect(briefing).toContain('Short summary.')
    expect(briefing).not.toContain('should not appear')
  })

  it('lists skills by name and says the bodies are fetched on request', () => {
    const briefing = buildExpertBriefing({ promptTools, skills: [skill('deployment', 'How we ship to production.')] })
    expect(briefing).toContain('deployment')
    expect(briefing).toMatch(/read the full text/i)
    expect(briefing).toMatch(/override your/i)
  })

  it('omits empty sections rather than printing a heading with nothing under it', () => {
    const briefing = buildExpertBriefing({ promptTools: [] })
    expect(briefing).not.toContain('Tools the junior can call')
    expect(briefing).not.toContain('Project knowledge')
  })
})

describe('cost accounting', () => {
  const context = {
    workspaceRoot: process.cwd(),
    fs: {} as ToolExecutionContext['fs'],
    terminal: {} as ToolExecutionContext['terminal'],
    denylist: {} as ToolExecutionContext['denylist'],
    readFiles: new Set<string>(),
  } as ToolExecutionContext

  /**
   * A consultation that fails can still have cost money — the CLI may have done work before
   * erroring. Counting only successes would make the running total quietly understate the
   * spend, which is the one thing a cost meter must never do.
   *
   * Driven through the unavailable-CLI path because it is the only failure reachable without
   * spawning a real process.
   */
  it('reports a failed consultation rather than skipping it', async () => {
    const seen: { costUsd?: number; isError: boolean }[] = []
    const tool = createAskExpertTool({
      cli: { available: false, executable: 'claude', reason: 'not installed' },
      onConsultation: (info) => seen.push(info),
    })

    const result = await tool.execute({ question: 'anything' }, context)

    expect(result.isError).toBe(true)
    expect(seen).toEqual([{ isError: true }])
  })

  /** Absent is not zero. A total that added it as zero would look exact while being incomplete. */
  it('omits costUsd entirely when the CLI reported none', async () => {
    const seen: { costUsd?: number; isError: boolean }[] = []
    const tool = createAskExpertTool({
      cli: { available: false, executable: 'claude', reason: 'not installed' },
      onConsultation: (info) => seen.push(info),
    })

    await tool.execute({ question: 'anything' }, context)
    expect(Object.hasOwn(seen[0] ?? {}, 'costUsd')).toBe(false)
  })

  it('mentions that consultations continue one conversation, so context is not repeated', () => {
    const tool = createAskExpertTool({ cli: { available: true, executable: 'claude' } })
    expect(tool.description).toMatch(/continue the same conversation/i)
  })
})
