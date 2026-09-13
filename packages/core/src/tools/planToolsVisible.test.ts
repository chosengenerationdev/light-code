import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

/**
 * A tool named in guidance must be in the tool block.
 *
 * Reported from real use: agent team mode opens by telling the model to propose the expert's plan
 * with `update_plan`, the plan tools followed the dispatcher, and with the dispatcher on — which
 * is the default — that tool was not in the list the model could see. It was under instruction to
 * call something invisible, with `write_to_file` plainly available, and it wrote the plan into a
 * file. That looks like progress and is not: nothing reads the file, the progress panel stays
 * empty, and the user approved nothing.
 *
 * "Reachable through `search_docs`" was the defence and it does not hold. It asks the model to
 * notice an absence, infer indirection and spend a step on it, which a model under instruction to
 * get on with the plan will not do.
 *
 * These read the source because the defect is a *registration option*, invisible to any test of
 * what the tools do — the same reasoning as `config/retrieval.test.ts` reading `bridge.ts`.
 */
describe('the plan tools are advertised, not hidden', () => {
  const bridge = read('../host/bridge.ts')

  it('registers both without dispatchOnly', () => {
    expect(bridge).toContain('combined.register(createUpdatePlanTool(planAccess))')
    expect(bridge).toContain('combined.register(createPlanProgressTool(planAccess))')
  })

  /*
   * The specific regression. Restoring `{ dispatchOnly: dispatcher }` here would reproduce the
   * report exactly, and nothing about the tools themselves would look wrong.
   */
  it('does not let either follow the dispatcher', () => {
    expect(bridge).not.toMatch(/createUpdatePlanTool\(planAccess\),\s*\{\s*dispatchOnly/)
    expect(bridge).not.toMatch(/createPlanProgressTool\(planAccess\),\s*\{\s*dispatchOnly/)
  })

  /*
   * Still registered whatever the plan is. Making the registry a function of whether a plan is
   * set would put the plan into the prompt's static prefix, which is the one thing §12 rules out
   * — so the fix for one half of this must not break the other.
   */
  it('registers them unconditionally, never keyed on whether a plan exists', () => {
    const at = bridge.indexOf('combined.register(createUpdatePlanTool')
    expect(at).toBeGreaterThan(-1)
    const before = bridge.slice(Math.max(0, at - 200), at)
    expect(before).not.toMatch(/if \(.*activePlan/)
  })
})

describe('the workaround the model reached for is named and refused', () => {
  const guidance = read('../agents/guidance.ts')

  it('tells it never to write the plan to a file', () => {
    expect(guidance).toContain('Never write the plan to a file')
  })

  /*
   * And what to do instead, because an instruction that only forbids leaves a model that has hit
   * a failure with nowhere to go — which is how it invented the file in the first place.
   */
  it('says to report the failure rather than route around it', () => {
    expect(guidance).toContain('If `update_plan` fails, say')
  })
})
