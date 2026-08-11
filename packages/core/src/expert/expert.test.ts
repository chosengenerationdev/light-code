import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../agent/systemPrompt.js'
import { createAskExpertTool } from '../tools/askExpert.js'
import { detectClaudeCli } from './claudeCli.js'
import type { ToolExecutionContext } from '../tools/types.js'

describe('detectClaudeCli', () => {
  /** A missing CLI must be a reportable state, never a throw that breaks a turn. */
  it('reports a missing executable with an actionable reason', async () => {
    const info = await detectClaudeCli('definitely-not-a-real-command-xyz')

    expect(info.available).toBe(false)
    expect(info.reason).toMatch(/npm install -g @anthropic-ai\/claude-code/)
  })

  it('reports the command it actually tried, so the UI is not guessing', async () => {
    expect((await detectClaudeCli('definitely-not-a-real-command-xyz')).executable).toBe(
      'definitely-not-a-real-command-xyz',
    )
  })
})

describe('ask_expert', () => {
  const context = {
    workspaceRoot: process.cwd(),
    fs: {} as ToolExecutionContext['fs'],
    terminal: {} as ToolExecutionContext['terminal'],
    denylist: {} as ToolExecutionContext['denylist'],
    readFiles: new Set<string>(),
  } as ToolExecutionContext

  it('is in the read group — it changes nothing in the workspace', () => {
    const tool = createAskExpertTool({ cli: { available: true, executable: 'claude' } })
    expect(tool.group).toBe('read')
  })

  /** Invariant 8: the user is paying per call, so they see the exact question being sent. */
  it('previews the literal question rather than a summary of it', async () => {
    const tool = createAskExpertTool({ cli: { available: true, executable: 'claude' } })
    const preview = await tool.preview?.({ question: 'Why does the retry loop hang?' }, context)

    expect(preview).toMatchObject({ kind: 'text' })
    expect((preview as { text: string }).text).toContain('Why does the retry loop hang?')
  })

  it('fails clearly when the CLI is unavailable, without spawning anything', async () => {
    const tool = createAskExpertTool({
      cli: { available: false, executable: 'claude', reason: 'not found on PATH' },
    })
    const result = await tool.execute({ question: 'anything' }, context)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found on PATH')
  })

  it("describes itself as costing money, so the model does not reach for it casually", () => {
    const tool = createAskExpertTool({ cli: { available: true, executable: 'claude' } })
    expect(tool.description).toMatch(/costs the user money/i)
    // And states the read-only boundary, so the model does not ask it to make changes.
    expect(tool.description).toMatch(/cannot edit or run/i)
  })
})

describe('system prompt', () => {
  /**
   * Models answer "what model are you?" from training data, which is wrong behind a gateway
   * that renames things — and was wrong for a DeepSeek deployment back in Phase 2b. The
   * configured id is the only reliable source.
   */
  it('states the configured model and profile', () => {
    const prompt = buildSystemPrompt('/repo', { model: 'internal-qwen3-coder', providerLabel: 'Corp Gateway' })

    expect(prompt).toContain('internal-qwen3-coder')
    expect(prompt).toContain('Corp Gateway')
    expect(prompt).toMatch(/do not guess from your training data/i)
  })

  it('omits the identity section when no model is known', () => {
    expect(buildSystemPrompt('/repo')).not.toMatch(/About you/)
  })

  it('explains the expert only when one is available', () => {
    expect(buildSystemPrompt('/repo', { expertAvailable: true })).toMatch(/ask_expert/)
    expect(buildSystemPrompt('/repo', { expertAvailable: false })).not.toMatch(/ask_expert/)
  })

  it('tells the model the expert costs money and cannot see the workspace', () => {
    // Whitespace-normalised: the prompt is hand-wrapped, and a wrap landing mid-phrase
    // should not fail a test about meaning.
    const prompt = buildSystemPrompt('/repo', { expertAvailable: true }).replace(/\s+/g, ' ')

    expect(prompt).toMatch(/costs real money/i)
    expect(prompt).toMatch(/cannot see this conversation/i)
    // And that it stays responsible, so it does not transcribe advice unverified.
    expect(prompt).toMatch(/verify it against the actual code/i)
  })

  /**
   * The bug this guards against, observed live: DeepSeek had `ask_expert` available, was
   * asked "can you say hello to Claude?", and replied that it had "no way to communicate
   * with other AI assistants". The frugality guidance had talked it out of a direct
   * instruction, and it reported the choice as an inability.
   */
  it('makes an explicit user request override the be-frugal guidance', () => {
    const prompt = buildSystemPrompt('/repo', { expertAvailable: true }).replace(/\s+/g, ' ')

    expect(prompt).toMatch(/if the user asks you to consult it, do so/i)
    expect(prompt).toMatch(/never tell the user you have no way to reach another model/i)
    // And if it does decline, it must say it chose to, not that it could not.
    expect(prompt).toMatch(/do not say you are unable to/i)
  })

  it('is stable for a given configuration, so the cache prefix survives', () => {
    const options = { model: 'gpt-4o', providerLabel: 'OpenAI', expertAvailable: true }
    expect(buildSystemPrompt('/repo', options)).toBe(buildSystemPrompt('/repo', options))
  })
})
