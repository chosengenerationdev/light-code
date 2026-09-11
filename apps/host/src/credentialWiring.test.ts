import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The credential function has to actually reach the store the product reads from.
 *
 * `credentialTool.test.ts` proves the store resolves a pointer. It cannot see whether anything
 * *gives* the session that store — a missing call, which is the defect shape CLAUDE.md names as
 * the most expensive here, and which no test of the owner can detect. So these read the source
 * along the one path a credential travels: flag, server, session, store.
 */
function read(...parts: string[]): string {
  return readFileSync(path.join(__dirname, ...parts), 'utf8')
}

describe('a credential reaching the product', () => {
  it('is accepted on the command line', () => {
    const cli = read('cli.ts')
    expect(cli).toContain("valueOf(args, '--credential-tool')")
    // An unknown flag is refused rather than ignored, so it has to be registered as known too.
    expect(cli).toContain("'--credential-tool',")
  })

  it('is handed to the server', () => {
    expect(read('cli.ts')).toContain(
      'credentialTool: { interpreter: credentialPython, file: credentialTool }',
    )
  })

  it('is handed from the server to each session', () => {
    expect(read('server.ts')).toContain('credentialTool: options.credentialTool')
  })

  /**
   * And the session wraps the store with it.
   *
   * Outermost, outside the shared/personal routing: which *file* a reference belongs to and
   * whether its value is a pointer are separate questions, and an administrator's shared
   * credential is exactly as likely to come from a vault as a personal one.
   */
  it('wraps the secret store rather than replacing it', () => {
    const session = read('session.ts')
    expect(session).toContain('withCredentialTool(')
    expect(session).toContain('new ToolBackedSecretStore(')
    // Ordinary secrets still work: absent means the store is returned untouched.
    expect(session).toContain('if (options.credentialTool === undefined) return store')
  })

  /**
   * The assistant must not be able to call it.
   *
   * §15 keeps secrets out of the model's environment, and a credential lookup is the last place
   * to make an exception: a tool the model called would put the password in the transcript, the
   * task history and whatever it said next. It is a secret *source*, reached only by the code
   * that was already allowed to resolve one.
   */
  it('is not registered as a tool anywhere', () => {
    const core = path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src')
    const bridge = readFileSync(path.join(core, 'host', 'bridge.ts'), 'utf8')
    for (const name of ['credentialTool', 'ToolBackedSecretStore', 'fetchCredential']) {
      expect(bridge.includes(name), `the bridge knows about ${name}`).toBe(false)
    }
  })

  /** Node-host only, like everything else in this round. */
  it('leaves the extension alone', () => {
    const extension = readFileSync(
      path.join(__dirname, '..', '..', 'vscode', 'src', 'extension.ts'),
      'utf8',
    )
    expect(extension.includes('credentialTool')).toBe(false)
  })
})
