import { describe, expect, it } from 'vitest'

import { AUTO_MODE, CODE_MODE } from '../modes/builtin.js'
import { decideFromPolicy } from './policy.js'
import { couldChain, isSafeCommand } from './safeCommands.js'
import { riskyCommandRules } from './riskyCommands.js'
import type { ApprovalRequest } from './types.js'

/**
 * Commands that run without asking in Auto mode.
 *
 * §8 forbids prefix matching in the allowlist because `grep foo && rm -rf /` begins with a
 * harmless prefix. That objection is answered here by refusing to consider anything that could
 * chain at all — so most of this file is about that refusal, which is the only thing holding the
 * rest up.
 */

const command = (text: string): ApprovalRequest =>
  ({
    toolName: 'execute_command',
    group: 'command',
    preview: { kind: 'command', command: text },
  }) as unknown as ApprovalRequest

describe('refusing anything that could chain', () => {
  it('rejects every shell metacharacter, whatever the command starts with', () => {
    /*
     * The heart of it. Each of these begins with something on the safe list and does something
     * else entirely, and none of them needs the grammar to be parsed to be refused.
     */
    for (const text of [
      'grep foo src && rm -rf /',
      'cat file; rm -rf /',
      'ls | xargs rm',
      'cat a > b',
      'echo $(rm -rf /)',
      'echo `rm -rf /`',
      'git status & rm -rf /',
      'ls\nrm -rf /',
    ]) {
      expect(couldChain(text), text).toBe(true)
      expect(isSafeCommand(text), text).toBe(false)
    }
  })

  it('refuses a quoted metacharacter too, which is the conservative direction', () => {
    // `grep "a;b" file` is harmless and still asks. An extra prompt is a cost this can afford;
    // deciding which semicolons are inside quotes is the parsing it exists to avoid.
    expect(isSafeCommand('grep "a;b" file')).toBe(false)
  })
})

describe('what qualifies', () => {
  it('lets reading and searching through', () => {
    for (const text of [
      'ls -la',
      'cat src/index.ts',
      'sed -n 200,260p src/ledger.ts',
      'rg -n acquireLock src',
      'git status',
      'git diff --stat',
      'wc -l src/index.ts',
    ]) {
      expect(isSafeCommand(text), text).toBe(true)
    }
  })

  it('lets compiling through, but not executing', () => {
    // The distinction the user asked about: compiling is not running.
    expect(isSafeCommand('python -m py_compile app.py')).toBe(true)
    expect(isSafeCommand('python --version')).toBe(true)
    expect(isSafeCommand('python app.py')).toBe(false)
    expect(isSafeCommand('python -c print(1)')).toBe(false)
  })

  it('does not vouch for a longer program with the same start', () => {
    // `ls` must not cover `lsof`, nor `pwd` cover `pwdx`.
    expect(isSafeCommand('lsof -i :3000')).toBe(false)
    expect(isSafeCommand('pwdx 1')).toBe(false)
  })

  it('keeps `find` off the list on purpose', () => {
    /*
     * `find . -delete` needs no metacharacter at all. The program is not the risk; its own flags
     * are, and reasoning about those is exactly what this design refuses to do.
     */
    expect(isSafeCommand('find . -delete')).toBe(false)
    expect(isSafeCommand('find . -name x')).toBe(false)
  })

  it('treats git by subcommand, not by program', () => {
    expect(isSafeCommand('git log --oneline -5')).toBe(true)
    expect(isSafeCommand('git push origin main')).toBe(false)
    expect(isSafeCommand('git clean -fd')).toBe(false)
  })

  it('takes the user\'s own prefixes on the same terms', () => {
    const options = { extra: ['cargo check'] }
    expect(isSafeCommand('cargo check --all', options)).toBe(true)
    // Still nothing that could chain, however it was added.
    expect(isSafeCommand('cargo check && rm -rf /', options)).toBe(false)
  })

  it('can be reduced to the user\'s own list alone', () => {
    expect(isSafeCommand('ls', { builtin: false })).toBe(false)
    expect(isSafeCommand('ls', { extra: ['ls'], builtin: false })).toBe(true)
  })
})

describe('when it applies', () => {
  const safe = { enabled: true }
  const risky = riskyCommandRules()

  it('runs a safe command unprompted in Auto mode', () => {
    expect(decideFromPolicy(command('cat src/index.ts'), undefined, risky, safe)).toBe('approve')
  })

  it('still asks in every other mode', () => {
    // The relaxation belongs to the mode. `enabled` false is what Code mode passes.
    expect(
      decideFromPolicy(command('cat src/index.ts'), undefined, risky, { enabled: false }),
    ).toBeUndefined()
    expect(decideFromPolicy(command('cat src/index.ts'), undefined, risky)).toBeUndefined()
  })

  it('never overrides a risky rule', () => {
    /*
     * Checked after the risky list, so a command that is both asks. Without that ordering, adding
     * something to the safe list could silence a refusal — which is the one thing safety here must
     * not be able to do.
     */
    const options = { enabled: true, extra: ['git'] }
    expect(decideFromPolicy(command('git reset --hard'), undefined, risky, options)).toBeUndefined()
  })

  it('still asks for a command nobody vouched for', () => {
    expect(decideFromPolicy(command('./deploy.sh'), undefined, risky, safe)).toBeUndefined()
  })
})

describe('the mode declares it', () => {
  it('is Auto mode, and only Auto mode', () => {
    expect(AUTO_MODE.autoApproveSafeCommands).toBe(true)
    expect(CODE_MODE.autoApproveSafeCommands).toBeUndefined()
  })
})
