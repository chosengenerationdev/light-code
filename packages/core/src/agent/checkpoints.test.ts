import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  attributeConsultation,
  checkpointViews,
  markCheckpoint,
  parseCheckpoints,
  pruneProgress,
  type PlanProgress,
} from './checkpoints.js'
import { buildPlanGuidance } from './plan.js'
import { decideFromPolicy } from '../approval/policy.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import { createUpdatePlanTool } from '../tools/planTools.js'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('reading a plan as steps', () => {
  it('takes the list items and leaves a preamble alone', () => {
    const steps = parseCheckpoints(
      ['We are fixing the retry path.', '', '1. Fix http.ts', '2. Add a test', ''].join('\n'),
    )
    expect(steps.map((step) => step.text)).toEqual(['Fix http.ts', 'Add a test'])
    expect(steps.map((step) => step.index)).toEqual([1, 2])
  })

  it('falls back to plain lines, because people write plans that way', () => {
    const steps = parseCheckpoints('Fix http.ts\nAdd a test')
    expect(steps.map((step) => step.text)).toEqual(['Fix http.ts', 'Add a test'])
  })

  it('reads dashes and bullets as well as numbers', () => {
    expect(parseCheckpoints('- one\n* two\n• three').map((step) => step.text)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('gives two identically worded steps different ids', () => {
    const steps = parseCheckpoints('1. run the tests\n2. run the tests')
    expect(steps[0]?.id).not.toBe(steps[1]?.id)
  })
})

describe('progress surviving the user editing their plan', () => {
  /*
   * The whole reason ids are content-derived. With positional ids, inserting a step at the top
   * silently moves "done" onto work nobody did — and the panel would then report it as finished,
   * which is the kind of quiet false claim that is never noticed until it matters.
   */
  it('keeps a finished step finished when another is inserted above it', () => {
    const before = '1. Fix http.ts\n2. Add a test'
    const steps = parseCheckpoints(before)
    const progress = markCheckpoint(before, {}, 2, 'done')
    expect(progress).toBeDefined()

    const after = '1. Reproduce it\n2. Fix http.ts\n3. Add a test'
    const views = checkpointViews(after, pruneProgress(after, progress))

    expect(views.map((view) => `${String(view.index)} ${view.status}`)).toEqual([
      '1 todo',
      '2 todo',
      '3 done',
    ])
    expect(views[2]?.id).toBe(steps[1]?.id)
  })

  it('drops progress for a step that has been edited away', () => {
    const before = '1. Fix http.ts\n2. Delete the cache'
    const progress = markCheckpoint(before, {}, 2, 'done') as PlanProgress
    expect(Object.keys(pruneProgress('1. Fix http.ts', progress))).toEqual([])
  })

  it('refuses a step number the plan does not have', () => {
    expect(markCheckpoint('1. Only one step', {}, 4, 'done')).toBeUndefined()
  })
})

describe('who a step is attributed to', () => {
  it('records a consultation against whichever step is active', () => {
    const plan = '1. Fix http.ts\n2. Add a test'
    let progress = markCheckpoint(plan, {}, 1, 'active') as PlanProgress
    progress = attributeConsultation(progress, 'reviewer')
    progress = attributeConsultation(progress, 'reviewer')
    progress = attributeConsultation(progress, 'tester')

    expect(checkpointViews(plan, progress)[0]?.roles).toEqual(['reviewer', 'tester'])
  })

  it('keeps the roles when the step moves from active to done', () => {
    const plan = '1. Fix http.ts'
    let progress = markCheckpoint(plan, {}, 1, 'active') as PlanProgress
    progress = attributeConsultation(progress, 'expert')
    progress = markCheckpoint(plan, progress, 1, 'done') as PlanProgress

    expect(checkpointViews(plan, progress)[0]).toMatchObject({
      status: 'done',
      roles: ['expert'],
    })
  })

  it('attributes nothing when no step is active', () => {
    const progress = attributeConsultation({}, 'expert')
    expect(progress).toEqual({})
  })
})

describe('what the assistant is told', () => {
  it('numbers the steps the same way the panel does', () => {
    const plan = 'Some context.\n1. Fix http.ts\n2. Add a test'
    const guidance = buildPlanGuidance(plan)
    const steps = parseCheckpoints(plan)

    for (const step of steps) {
      expect(guidance).toContain(`${String(step.index)}. ${step.text}`)
    }
    expect(guidance).toContain('plan_progress')
    expect(guidance).toContain('update_plan')
  })

  it('stays empty with no plan, so an unplanned chat costs nothing', () => {
    expect(buildPlanGuidance(undefined)).toBe('')
    expect(buildPlanGuidance('   ')).toBe('')
  })
})

describe('changing the plan needs the user', () => {
  /*
   * The trap this is here for: `decideFromPolicy` answers `approve` for the `always` group
   * *before* it consults ALWAYS_ASK_TOOLS. Grouping `update_plan` there — which is tempting,
   * since it edits no file — would have silently auto-approved the one permission the feature
   * exists to ask for, and nothing else in the suite would have noticed.
   */
  it('is never auto-approved, even with every category switched on', () => {
    const tool = createUpdatePlanTool({
      current: () => undefined,
      save: async () => undefined,
      mark: async () => ({ ok: false, reason: 'no' }),
    })

    expect(tool.group).not.toBe('always')

    const decision = decideFromPolicy(
      {
        id: 'probe',
        toolName: 'update_plan',
        group: tool.group,
        preview: { kind: 'text', text: '' },
      },
      {
        autoApprove: { read: true, edit: true, command: true, mcp: true },
        allowedTools: ['update_plan'],
        allowedCommands: [],
      },
    )

    expect(decision).toBeUndefined()
  })

  it('is never available to an unattended run', () => {
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('update_plan')
  })

  it('shows the user a diff of their plan against the proposal', async () => {
    const tool = createUpdatePlanTool({
      current: () => '1. Fix http.ts',
      save: async () => undefined,
      mark: async () => ({ ok: false, reason: 'no' }),
    })

    const preview = await tool.preview?.(
      { plan: '1. Fix http.ts\n2. Add a test', reason: 'the expert suggested a test' },
      {} as never,
    )

    expect(preview).toMatchObject({
      kind: 'diff',
      before: '1. Fix http.ts',
      after: '1. Fix http.ts\n2. Add a test',
      note: 'the expert suggested a test',
    })
  })
})

describe('the wiring, which no test of the parts can see', () => {
  /*
   * Each of these is a *missing call* — the defect shape this repo has been bitten by most often
   * (an empty Agents tab because nothing posted `requestAgents`). A panel that is never sent its
   * data is indistinguishable from a panel that is broken, and only reading the source shows it.
   */
  const bridge = read('../host/bridge.ts')

  it('registers both plan tools', () => {
    expect(bridge).toContain('createUpdatePlanTool(planAccess)')
    expect(bridge).toContain('createPlanProgressTool(planAccess)')
  })

  it('posts progress when a task is opened, replaced, or asked about', () => {
    expect(bridge).toContain("message.type === 'requestPlanProgress'")
    // Restoring a task and starting a new one both have to resend it, or the panel shows the
    // previous conversation's progress against this conversation's plan.
    expect(bridge.match(/postPlanProgress\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  it('routes the user-set plan through the same owner as an approved update', () => {
    expect(bridge).toContain('void applyPlan(message.plan)')
  })

  it('tells agent team mode whether a plan already exists', () => {
    const guidance = read('../agents/guidance.ts')
    expect(guidance).toContain('PLAN_FIRST')
    expect(guidance).toContain('PLAN_IN_PLACE')
    expect(guidance).toContain('Ask the expert for the plan')
    // Passed, not inferred: the mode must not guess at whether the plan section is present.
    expect(bridge).toContain('activePlan !== undefined && activePlan.trim().length > 0,')
  })
})
