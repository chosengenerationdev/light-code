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

  it('compiles a project, not only one file', () => {
    // `compileall` was missing, which is how anybody compiles more than a single file.
    expect(isSafeCommand('python -m compileall .')).toBe(true)
    expect(isSafeCommand('python -m compileall src')).toBe(true)
  })

  it('knows how Python is actually spelled on Windows', () => {
    /*
     * Reported from real use: compiling still asked in Auto mode. Every one of these is the same
     * act as `python -m py_compile`, written the way this platform writes it - through the `py`
     * launcher, through an `.exe`, or through the interpreter inside a virtualenv, which is what
     * this product's own Python tooling uses. Each miss is a prompt, and enough of them is the
     * mode being unusable rather than careful.
     */
    for (const text of [
      'py -m py_compile app.py',
      'python.exe -m py_compile app.py',
      '.venv\\Scripts\\python.exe -m py_compile app.py',
      'D:\\proj\\.venv\\Scripts\\python -m py_compile app.py',
      '"C:\\Program Files\\Python\\python.exe" -m py_compile app.py',
      '/usr/bin/python3 -m py_compile app.py',
    ]) {
      expect(isSafeCommand(text), text).toBe(true)
    }
  })

  it('reaching the interpreter by path does not make running a script safe', () => {
    // The path is normalised; what it is asked to *do* is judged exactly as before.
    expect(isSafeCommand('python.exe app.py')).toBe(false)
    expect(isSafeCommand('.venv\\Scripts\\python.exe app.py')).toBe(false)
    expect(isSafeCommand('py app.py')).toBe(false)
    expect(isSafeCommand('/usr/bin/python3 -c print(1)')).toBe(false)
  })

  it('refuses a metacharacter hiding in the program path', () => {
    /*
     * The order this pins: chain check first, normalisation second. Normalising removes the
     * directory, so doing it the other way round would strip the `&` and vouch for the result.
     */
    expect(isSafeCommand('C:\\a&b\\python.exe -m py_compile app.py')).toBe(false)
    expect(isSafeCommand('/opt/a;b/python3 -m py_compile app.py')).toBe(false)
  })

  it('normalises a Windows shim, since npm and pnpm are one', () => {
    expect(isSafeCommand('npm.cmd --version')).toBe(true)
  })

  it('sees the action behind an interpreter flag', () => {
    /*
     * Asked directly, about `-X`. It is not dangerous and cannot be: the interpreter accepts
     * `-X` keys it has never heard of - measured, `python -X totally_made_up_key --version` just
     * prints the version - because they are data in `sys._xoptions`, not code to run. It was
     * stopping for approval only because a literal prefix cannot see past a flag, so the modifier
     * hid the action from the rule.
     */
    for (const text of [
      'python -X utf8 -m py_compile app.py',
      'python -X dev -m py_compile app.py',
      'python -Xdev -m py_compile app.py',
      'python -X utf8 -X dev -m compileall .',
      'python -B -m py_compile app.py',
      'python -W ignore -m py_compile app.py',
      'python -I -O -m compileall src',
      'py -3.12 -m py_compile app.py',
      '.venv\\Scripts\\python.exe -X utf8 -m py_compile app.py',
    ]) {
      expect(isSafeCommand(text), text).toBe(true)
    }
  })

  it('skipping a flag never turns running into compiling', () => {
    /*
     * The half that matters. The flags are skipped so the *action* can be judged, and the action
     * is judged exactly as it was before: `-c`, `-m <anything nobody vouched for>` and a bare
     * filename all still ask, however many modifiers precede them.
     */
    expect(isSafeCommand('python -X dev app.py')).toBe(false)
    expect(isSafeCommand('python -X utf8 -c print(1)')).toBe(false)
    expect(isSafeCommand('python -X dev -m pytest')).toBe(false)
    expect(isSafeCommand('python -m pip install requests')).toBe(false)
    expect(isSafeCommand('py -3 app.py')).toBe(false)
    // No action at all is an interactive interpreter, which would sit waiting on stdin.
    expect(isSafeCommand('python -X dev')).toBe(false)
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
