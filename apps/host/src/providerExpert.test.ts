import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildExpertPrompt } from '@light-code/core'

/**
 * The Node host consults a **configured provider profile**, not the Claude CLI.
 *
 * Asked for in these terms: the expert should be any model already configured, and cost is no
 * longer something to manage in the product. Both follow from where this runs — there is no
 * `claude` binary on a server, and the gateway answering the chat already has a stronger model
 * behind it.
 *
 * Added rather than substituted, because `packages/core` and `packages/ui` are shared and the
 * extension still has the CLI expert with its budget and its meter. So these checks are about
 * the *seam* holding: the host asks for one kind, the extension asks for nothing and keeps the
 * other, and neither knows about the other's controls.
 */
const hostSrc = __dirname
const coreSrc = path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src')
const uiSrc = path.join(__dirname, '..', '..', '..', 'packages', 'ui', 'src')

/** Source with comments removed, so a check for a field name cannot match an explanation. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
}

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), 'utf8')
}

describe('the host and its expert', () => {
  it('asks for the profile kind', () => {
    expect(read(hostSrc, 'session.ts')).toContain("expertMode: 'profile'")
  })

  /**
   * Only one tool may be called `ask_expert`.
   *
   * Registering both would leave which one wins to registration order — the kind of thing that
   * works until somebody reorders two lines, and then the expert silently becomes a binary that
   * does not exist on this machine.
   */
  it('registers one expert tool or the other, never both', () => {
    const bridge = read(coreSrc, 'host', 'bridge.ts')
    const at = bridge.indexOf('const providerExpert = cachedProviderExpert')
    expect(at).toBeGreaterThan(-1)
    // The CLI branch is the `else` of the provider one.
    expect(bridge.slice(at, at + 1400)).toContain('else if (expert !== undefined)')
  })

  /** A missing profile means no expert, not a quiet fall back to the model already stuck. */
  it('does not fall back to the chat model when the profile is gone', () => {
    const bridge = read(coreSrc, 'host', 'bridge.ts')
    const at = bridge.indexOf('function providerExpertFor')
    expect(at).toBeGreaterThan(-1)
    const body = bridge.slice(at, at + 1800)
    expect(body).toContain('the expert is unavailable')
    expect(body).toContain('return undefined')
  })
})

describe('what the profile expert is told', () => {
  const prompt = buildExpertPrompt({ question: 'Why does this deadlock?', files: ['src/a.ts'] })

  /*
   * The CLI expert is given Read, Grep and Glob and gathers its own context. A profile is one
   * request with no tools, so a prompt that did not say so invites "I would need to see the
   * file" — a round trip that tells the asker nothing they can act on.
   */
  it('says it cannot read the workspace', () => {
    expect(prompt).toContain('cannot see the workspace')
    expect(prompt).toContain('do not refuse to answer')
  })

  it('says its reply is advice to be checked, not instructions', () => {
    expect(prompt).toContain('Your reply is advice')
  })

  it('lists named files as context rather than as something to open', () => {
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('You cannot open them')
  })

  it('carries the question itself', () => {
    expect(prompt).toContain('Why does this deadlock?')
  })
})

describe('the cost machinery stays with the CLI expert', () => {
  /**
   * The point of the rework, checked where it is visible.
   *
   * A spend cap over something nothing meters is a control that looks like protection and is
   * not; a savings figure derived from a price nobody measured is a number that gets believed.
   * CLAUDE.md's rule about reporting a floor rather than a guess is the same rule: where nothing
   * is known, say nothing rather than zero.
   */
  it('keeps budget, pricing and savings out of the profile panel', () => {
    /*
     * Comments stripped first, and that is not a detail.
     *
     * The panel's own documentation explains at length which controls are missing and why, so a
     * naive substring search over the file matches the explanation and fails. A test that reads
     * source has to read the source rather than the prose around it, or it measures the writing.
     */
    const panel = withoutComments(read(uiSrc, 'settings', 'ExpertProfilePanel.tsx'))
    for (const absent of [
      'maxSpendUsd',
      'maxConsultations',
      'pricing',
      'savings',
      'keepAlive',
      'assessment',
    ]) {
      expect(panel.includes(absent), `the profile panel renders ${absent}`).toBe(false)
    }
  })

  it('keeps the per-task spend meter out of the chat header in profile mode', () => {
    expect(read(uiSrc, 'App.tsx')).toContain("expert?.mode !== 'profile' && (")
  })

  /**
   * And the per-chat spend line is absent by construction rather than by another condition.
   *
   * `ExpertSpend` renders nothing at zero consultations, and the count only moves when a tool
   * reports one. The provider tool takes no such callback at all, so there is no path by which a
   * count could rise — which is a better guarantee than a second place remembering to hide it.
   */
  it('has no way to report a consultation, so nothing counts them', () => {
    const tool = withoutComments(read(coreSrc, 'tools', 'askProviderExpert.ts'))
    expect(tool.includes('onConsultation'), 'the provider expert reports consultations').toBe(false)
    expect(tool.includes('costUsd'), 'the provider expert reports a cost').toBe(false)
    expect(tool.includes('budget'), 'the provider expert consults a budget').toBe(false)
  })

  /*
   * The other half of "node only". The CLI expert, its budget and its meter are still what the
   * extension has, and absent means CLI — so a host that says nothing is unchanged.
   */
  it('leaves the extension on the CLI expert', () => {
    const extension = [
      read(hostSrc, '..', '..', 'vscode', 'src', 'extension.ts'),
      read(hostSrc, '..', '..', 'vscode', 'src', 'webview', 'chatViewProvider.ts'),
    ].join('\n')
    expect(extension.includes('expertMode'), 'the extension now declares an expert mode').toBe(
      false,
    )
  })
})
