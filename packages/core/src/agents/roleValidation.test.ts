import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isAgentRole } from './roles.js'

const bridge = readFileSync(fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')

/**
 * Every place that asks "is this a role?" has to know about the roles the user invented.
 *
 * ## The reported failure
 *
 * A custom role appeared in the Agents tab, with its checkboxes, and then refused to accept a
 * provider: *There is no "test-role" role.* Three handlers — assigning somebody, editing the
 * prompt, setting the colour — still called `isAgentRole(role)` with one argument, so they knew
 * only the built-in five. The role existed everywhere except the places that let you configure it,
 * which is a role you can create and cannot use.
 *
 * ## Why this is read from the source
 *
 * The defect is a **call site that did not learn something**, and no test of `isAgentRole` can see
 * it: the function is correct, and was correct throughout. The same shape as
 * `config/retrieval.test.ts` reading `bridge.ts` for a directly-read config key, and as
 * `agentsRequested.test.ts` reading `App.tsx` for a message nobody posted. A defect that lives in
 * the absence of an argument has to be looked for where the argument is absent.
 */
describe('validating a role id', () => {
  it('recognises a custom role when it is given the definitions', () => {
    const definitions = [{ id: 'test-role', name: 'Test Role', summary: '', prompt: '' }]
    expect(isAgentRole('test-role', definitions)).toBe(true)
    // And still refuses one that exists nowhere, which is what the guard is for.
    expect(isAgentRole('test-role')).toBe(false)
    expect(isAgentRole('architect', definitions)).toBe(false)
  })

  it('is never called in the bridge without them', () => {
    /*
     * A bare `isAgentRole(role)` is the bug: it silently means "built-in roles only", and the
     * symptom is a control that refuses a role the panel is showing.
     */
    const bare = [...bridge.matchAll(/isAgentRole\([^),]*\)/g)].map((match) => match[0])
    expect(bare, `these call sites do not know about custom roles: ${bare.join(', ')}`).toEqual([])
  })

  it('guards each of the handlers that configure a role', () => {
    /*
     * `setAgentColor` is deliberately absent from this list.
     *
     * It asks a different question — see `colourable.test.ts`. Colour marks *authorship* and
     * belongs to anything that can author a reply; these four put a *model in a seat*, and must
     * keep refusing anything that is not one. Claude is the first thing that is one without being
     * the other, and having a single guard for both is what produced "There is no claude role"
     * from a picker that was sitting right there.
     */
    for (const type of ['setAgentRole', 'setAgentPrompt', 'setRoleTools', 'setRoleWrite']) {
      const at = bridge.indexOf(`message.type === '${type}'`)
      expect(at, `${type} is not handled`).toBeGreaterThan(-1)
      // The guard belongs with the handler, not somewhere upstream of it.
      const block = bridge.slice(at, at + 900)
      expect(block, `${type} does not validate the role`).toContain(
        'isAgentRole(role, cachedAgentDefinitions)',
      )
    }
  })

  /* Still guarded, just by the question that fits it. */
  it('guards the colour handler with the colour question', () => {
    const at = bridge.indexOf(`message.type === 'setAgentColor'`)
    expect(at).toBeGreaterThan(-1)
    expect(bridge.slice(at, at + 900)).toContain('isColourableAgent(role, cachedAgentDefinitions)')
  })
})
