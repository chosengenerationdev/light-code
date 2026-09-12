import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const prompt = readFileSync(
  fileURLToPath(new URL('../agent/systemPrompt.ts', import.meta.url)),
  'utf8',
)

/**
 * A hidden tool nobody is told about is a tool that does not exist.
 *
 * Reported: asked to change a specialist's prompt, the assistant replied that it could not —
 * *"that's Settings → Agents, done by hand in the UI"* — and offered to draft text to paste in.
 * The tools were registered and working. They are `dispatchOnly`, so nothing advertised them, and
 * the model had no reason to suspect there was anything to search for: reconfiguring its own team
 * is not a capability an assistant assumes it has.
 *
 * This is the second time in this file. `create_python_tool` was hidden the same way, and the
 * comment there records the same wrong answer, confidently given. The rule that keeps falling
 * over: **guidance written for the absent case, and the present case assumed to need none.**
 */
describe('the prompt says the role tools exist', () => {
  it('names each of them', () => {
    for (const tool of ['read_role_prompt', 'update_role', 'create_role', 'delete_role']) {
      expect(prompt, `${tool} is not mentioned in the system prompt`).toContain(tool)
    }
  })

  it('says it is something to do rather than to explain', () => {
    // The failure was not ignorance of the tool, it was the assistant explaining how the user
    // could do it by hand. Naming the tools without correcting that reflex fixes half of it.
    expect(prompt).toContain('something to do, not')
  })

  /*
   * The same guard as the Python block above it, generalised: a capability that only exists
   * behind the dispatcher has to be announced somewhere, or it is unreachable in practice.
   */
  it('keeps the same announcement for the Python tools, which had this bug first', () => {
    expect(prompt).toContain('create_python_tool')
  })
})
