import { describe, expect, it } from 'vitest'
import { hubGitCode, parsePorcelain } from './hubGit.js'

/** Fire Code's git buttons for a JupyterHub codebase run git on the hub, through the kernel. */
describe('git on the hub', () => {
  it('passes a commit message only as a string literal in an argument list, never through a shell', () => {
    const message = `fix "quotes"'; import os; os.system('rm -rf ~') #\n$(whoami)`
    const code = hubGitCode('commit', ['projects/risk'], message)
    expect(code).toContain(`['commit', '-m', ${JSON.stringify(message)}]`)
    expect(code).not.toContain('shell=True')
    expect(code).toContain("GIT_TERMINAL_PROMPT='0'")
  })

  it('reads status the way the sidebar counts it', () => {
    const counts = parsePorcelain(
      ['## main...origin/main [ahead 2, behind 1]', '?? new.py', ' M edited.py', ' D gone.py', 'R  renamed.py', 'old.py', ''].join('\0'),
    )
    expect(counts).toMatchObject({ added: 1, modified: 2, deleted: 1, ahead: 2, behind: 1, upstream: true, branch: 'main' })
    expect(counts.files).toEqual(['+ new.py', '~ edited.py', '- gone.py', '~ renamed.py'])
  })

  it('notices a branch with no remote, so a push knows to set one', () => {
    expect(parsePorcelain('## feature\0').upstream).toBe(false)
  })
})
