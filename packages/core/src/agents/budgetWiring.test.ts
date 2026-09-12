import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bridge = readFileSync(fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')
const consultAgent = bridge.slice(bridge.indexOf('async function consultAgent'))
const cliPath = consultAgent.slice(
  consultAgent.indexOf("if (agent.kind === 'cli')"),
  consultAgent.indexOf('const { config } = await configManager.load()'),
)

/**
 * Money spent by Claude counts, whichever role it was answering as.
 *
 * `recordConsultation` was wired only into `ask_expert`, the tool that predates roles. Once Claude
 * could be assigned to any role, a reviewer or librarian backed by the CLI spent real money the
 * meter never saw and the per-task budget never checked — and nothing looked wrong: the panel
 * simply under-reported, and a limit the user had set quietly did not apply.
 *
 * Pinned by reading the source because the defect is a **missing call**. Any test of the meter
 * passes while the path that should feed it does not, which is what let this sit there.
 */
describe('what a CLI consultation costs', () => {
  it('is checked against the budget before the call', () => {
    expect(cliPath).toContain('checkExpertBudget(expertSpend, effectiveExpertLimits())')
    expect(cliPath).toContain('if (!verdict.allowed) throw new Error(verdict.message)')
  })

  it('is recorded after it, for every role and not only the expert', () => {
    expect(cliPath).toContain('recordConsultation(')
    // No role check anywhere in here: the bill is the same whoever answered.
    expect(cliPath).not.toMatch(/agent\.role === 'expert'/)
  })

  /*
   * A consultation that errored partway can still have been charged. Counting only successes
   * drifts the meter quietly downwards, which is worse than not metering at all — an
   * under-reported number still gets believed.
   */
  it('records a failed consultation too', () => {
    const call = cliPath.slice(cliPath.indexOf('recordConsultation('))
    expect(call).toContain('isError: answer.isError')
    // Recorded before the throw, or the failing case never reaches it.
    expect(cliPath.indexOf('recordConsultation(')).toBeLessThan(
      cliPath.indexOf('if (answer.isError) throw'),
    )
  })

  /*
   * Only where something is actually counting. §12b: a cap over something nothing meters looks
   * like protection and is not, and a gateway bills somewhere this product cannot see.
   */
  it('applies the budget only where consultations are metered', () => {
    expect(cliPath).toContain('if (cachedBudgetMatters)')
  })
})
