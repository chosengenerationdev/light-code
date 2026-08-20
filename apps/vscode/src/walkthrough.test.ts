import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The walkthrough is a manifest pointing at files, and nothing at build time checks that the
 * files are there. A missing diagram is a broken image in the one place a new user looks first,
 * and it would ship green: the VSIX smoke test checks that referenced assets are *packaged*,
 * not that a step's `media` names something real before packaging begins.
 *
 * These also pin the two properties that make it a tour rather than a document — every settings
 * tab has a step, and every step that names a tab can open it.
 */
// `__dirname`, not `import.meta`: this package builds to CommonJS.
const ROOT = path.join(__dirname, '..')

interface Step {
  id: string
  title: string
  description: string
  media: { image?: Record<string, string>; markdown?: string; altText?: string }
  completionEvents?: string[]
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string }[]
    menus?: { commandPalette?: { command: string; when?: string }[] }
    walkthroughs: { id: string; steps: Step[] }[]
  }
}

const walkthrough = manifest.contributes.walkthroughs[0]
const steps = walkthrough?.steps ?? []

/** The tab strip, in order. A tab absent from the tour is a feature nobody is told about. */
const TABS = [
  'providers',
  'approvals',
  'mcp',
  'search',
  'expert',
  'schedules',
  'python',
  'tools',
  'skills',
  'network',
  'appearance',
]

describe('the walkthrough manifest', () => {
  it('has a step for every settings tab', () => {
    const ids = new Set(steps.map((step) => step.id))
    for (const tab of TABS) expect(ids.has(tab), `no walkthrough step for the ${tab} tab`).toBe(true)
  })

  it('also covers the parts that are not a tab', () => {
    const ids = steps.map((step) => step.id)
    // Where things are, the chat itself, and what leaves the machine.
    expect(ids).toContain('orientation')
    expect(ids).toContain('chat')
    expect(ids).toContain('privacy')
  })

  it('ships every image both steps reference', () => {
    for (const step of steps) {
      const image = step.media.image
      expect(image, `step ${step.id} has no image`).toBeDefined()
      for (const [variant, rel] of Object.entries(image ?? {})) {
        expect(existsSync(path.join(ROOT, rel)), `${step.id}/${variant} missing: ${rel}`).toBe(true)
      }
    }
  })

  /** A light-only diagram is white text on white for half the users. */
  it('gives every image a light and a dark variant', () => {
    for (const step of steps) {
      expect(Object.keys(step.media.image ?? {}).sort()).toEqual(['dark', 'hc', 'hcLight', 'light'])
    }
  })

  it('describes every diagram for a screen reader', () => {
    for (const step of steps) {
      expect((step.media.altText ?? '').length, `step ${step.id} has no altText`).toBeGreaterThan(40)
    }
  })

  /**
   * The point of the rewrite. Describing where a setting lives leaves the reader to find it;
   * a step about a tab has to be able to open that tab.
   */
  it('gives every tab step a button that opens it', () => {
    for (const tab of TABS) {
      const step = steps.find((candidate) => candidate.id === tab)
      expect(step, `no step for ${tab}`).toBeDefined()
      expect(
        step?.description.includes(`command:lightCode.openSettings?%5B%22${tab}%22%5D`),
        `the ${tab} step has no button that opens the ${tab} tab`,
      ).toBe(true)
    }
  })

  it('registers every command its buttons invoke', () => {
    const declared = new Set(manifest.contributes.commands.map((command) => command.command))
    for (const step of steps) {
      for (const match of step.description.matchAll(/command:([\w.]+)/g)) {
        expect(declared.has(match[1] ?? ''), `${step.id} invokes unregistered ${String(match[1])}`).toBe(true)
      }
    }
  })

  /** It takes a tab argument, so choosing it from the palette could only ever do the default. */
  it('hides the argument-taking command from the palette', () => {
    const entry = manifest.contributes.menus?.commandPalette?.find(
      (item) => item.command === 'lightCode.openSettings',
    )
    expect(entry?.when).toBe('false')
  })

  /**
   * The first two steps tick from state rather than from being clicked, so someone who already
   * has a provider is not told to go and add one.
   */
  it('completes the first steps from what the user has actually done', () => {
    const byId = new Map(steps.map((step) => [step.id, step]))
    expect(byId.get('providers')?.completionEvents).toContain('onContext:lightCode.hasProvider')
    expect(byId.get('chat')?.completionEvents).toContain('onContext:lightCode.hasChatted')
  })

  it('says what each step is about in its own title', () => {
    for (const step of steps) {
      expect(step.title.length).toBeGreaterThan(8)
      expect(step.description.length, `step ${step.id} is too thin to teach anything`).toBeGreaterThan(200)
    }
  })
})
