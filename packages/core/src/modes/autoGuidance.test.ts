import { describe, expect, it } from 'vitest'

import { isSafeCommand } from '../approval/safeCommands.js'
import type { CommandToolset, ResolvedShell } from '../platform/node/shell.js'
import { autoExamples, buildAutoGuidance, type AutoGuidanceEnvironment } from './autoGuidance.js'
import { AUTO_MODE } from './builtin.js'

/**
 * That Auto mode tells the model the truth about the machine it is on.
 *
 * The guidance it replaced said *"On Windows that is PowerShell unless it has been configured
 * otherwise"*. Measured on a real Windows machine: commands run in **cmd.exe**, nothing had ever
 * configured it otherwise because there was no setting, and `Get-ChildItem` there answers "is not
 * recognized as an internal or external command". So on this product's primary platform, the
 * mode's own instructions produced commands that could not run.
 */

const cmd: ResolvedShell = { command: undefined, kind: 'cmd', label: 'C:\\WINDOWS\\system32\\cmd.exe' }
const powershell: ResolvedShell = { command: 'powershell.exe', kind: 'powershell', label: 'Windows PowerShell 5.1' }
const posix: ResolvedShell = { command: undefined, kind: 'posix', label: '/bin/bash' }

const toolset = (present: string[], missing: string[] = []): CommandToolset => ({ present, missing })

/** A Windows machine with Git for Windows on PATH, which is the common developer case. */
const windowsWithGitTools: AutoGuidanceEnvironment = {
  shell: cmd,
  tools: toolset(['grep', 'findstr', 'sed', 'head', 'tail', 'cat', 'type', 'ls', 'git'], ['rg', 'jq']),
  platform: 'win32',
}

/** A locked-down corporate build with none of the POSIX toolkit. */
const windowsBare: AutoGuidanceEnvironment = {
  shell: cmd,
  tools: toolset(['findstr', 'type', 'git'], ['rg', 'grep', 'sed', 'head', 'tail', 'cat', 'ls', 'awk', 'jq']),
  platform: 'win32',
}

describe('the mode carries no static guidance of its own', () => {
  it('has none, so nothing can assert an environment it has not measured', () => {
    /*
     * The fix is not a better hard-coded sentence. A prompt that *states* the environment is a
     * second copy of a fact the host already knows, and it drifts the moment either changes -
     * which is precisely what happened.
     */
    expect(AUTO_MODE.guidance).toBeUndefined()
  })
})

describe('naming the shell', () => {
  it('says cmd.exe on Windows, and says cmdlets will fail', () => {
    const guidance = buildAutoGuidance(windowsWithGitTools)
    expect(guidance).toContain('cmd.exe')
    expect(guidance).toContain('not PowerShell')
    // The specific failure somebody would otherwise meet, named so the model does not try it.
    expect(guidance).toContain('Get-ChildItem')
    expect(guidance).not.toContain('On Windows that is PowerShell')
  })

  it('names the shell without its absolute path', () => {
    // `%ComSpec%` is `C:\\WINDOWS\\system32\\cmd.exe`; that is noise in a prompt.
    expect(buildAutoGuidance(windowsWithGitTools)).not.toContain('system32')
  })

  it('warns that PowerShell aliases shadow the GNU tools, when that is the shell', () => {
    /*
     * The reason the default was not simply switched: `ls -la`, `head -5`, `sort file`,
     * `diff a b` and `where x` are all cmdlet aliases there and fail on those arguments.
     */
    const guidance = buildAutoGuidance({ ...windowsWithGitTools, shell: powershell })
    expect(guidance).toContain('aliases shadow')
    expect(guidance).toContain('no `&&`')
    expect(guidance).not.toContain('not PowerShell')
  })

  it('leaves a POSIX shell alone', () => {
    const guidance = buildAutoGuidance({ ...windowsWithGitTools, shell: posix, platform: 'linux' })
    // Named as `bash`, not `/bin/bash`: the shell is named the way somebody would say it.
    expect(guidance).toContain('**bash**')
    expect(guidance).not.toContain('cmdlet')
  })
})

describe('naming the tools that are really there', () => {
  it('lists what is present and what is not', () => {
    const guidance = buildAutoGuidance(windowsWithGitTools)
    expect(guidance).toContain('**Available here:**')
    expect(guidance).toContain('`grep`')
    expect(guidance).toContain('**Not on this machine:**')
    expect(guidance).toContain('`rg`')
  })

  it('does not recommend a tool this machine lacks', () => {
    /*
     * The case that matters on a corporate Windows build. Guidance naming `grep` and `sed` where
     * neither exists produces a run of "not recognized" errors, which reads as the assistant
     * being broken rather than as the prompt being wrong about the machine.
     */
    const guidance = buildAutoGuidance(windowsBare)
    expect(guidance).toContain('findstr')
    // The reading idiom has to fall back to something that exists, and say why.
    expect(guidance).toContain('no `sed`')
    for (const absent of ['grep', 'sed', 'head']) {
      expect(
        autoExamples(windowsBare).join(' '),
        `${absent} was recommended on a machine without it`,
      ).not.toContain(absent)
    }
  })

  it('draws its "invoke by bare name" examples from tools that exist', () => {
    // It used to name `rg` as an example on a machine that does not have it - the exact fault
    // this whole module is about, reintroduced in a footnote.
    const guidance = buildAutoGuidance(windowsBare)
    const line = guidance.split('\n').find((each) => each.includes('bare name')) ?? ''
    expect(line).not.toContain('`rg`')
    expect(line).toContain('`findstr`')
  })
})

describe('what it says about cost', () => {
  it('tells the model NOT to chain, which is the opposite of what it used to say', () => {
    /*
     * The old guidance said to work in fewer, larger, chained commands because each is approved
     * separately. True in Code mode, **wrong in Auto**: anything containing `&` can never be
     * auto-approved, so chaining converts several free commands into one that stops and asks.
     * The model was being told to do the expensive thing, in the mode built to avoid it.
     */
    const guidance = buildAutoGuidance(windowsWithGitTools)
    expect(guidance).toContain('Chained ones never do')
    expect(guidance).toContain('cost you nothing')
    expect(guidance).not.toContain('fewer, larger commands')
  })

  it('tells the model what to do when a command it expected to be free asks anyway', () => {
    // Otherwise it either gives up on the shell or keeps retrying rephrasings, and the user
    // never learns that the list is theirs to add to.
    expect(buildAutoGuidance(windowsWithGitTools)).toContain('Settings → Approvals')
  })
})

describe('everything it recommends actually runs without asking', () => {
  /*
   * **This is what "Auto mode works as advertised" means**, and it is the only test here that
   * could catch the promise being broken silently. The mode tells the user that reading and
   * searching will not interrupt them; if an idiom in its own prompt is not on the safe list,
   * the model does exactly as instructed and the user gets the prompts the mode exists to
   * remove - with nothing anywhere to say why.
   */
  for (const [name, environment] of [
    ['Windows with Git tools', windowsWithGitTools],
    ['Windows with nothing', windowsBare],
    ['PowerShell', { ...windowsWithGitTools, shell: powershell }],
    ['POSIX', { ...windowsWithGitTools, shell: posix, platform: 'linux' as NodeJS.Platform }],
  ] as const) {
    it(`on ${name}`, () => {
      const examples = autoExamples(environment)
      expect(examples.length).toBeGreaterThan(2)
      for (const example of examples) {
        expect(isSafeCommand(example), `"${example}" would stop for approval`).toBe(true)
      }
    })
  }
})
