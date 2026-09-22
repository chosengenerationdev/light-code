import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectCommandTools, onPath, resolveShell } from './shell.js'

/**
 * What shell commands really run in, and which tools are really on PATH.
 *
 * Measured on a real Windows machine before any of this was written: `%ComSpec%` is
 * `C:\WINDOWS\system32\cmd.exe`, `Get-ChildItem` fails with "is not recognized", and Auto mode's
 * guidance said the shell was PowerShell. Being wrong about this put commands in the prompt that
 * could not run.
 */

const windows = process.platform === 'win32'

let scratch: string

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-shell-'))
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('resolveShell', () => {
  it('reports the platform default rather than guessing at one', () => {
    const resolved = resolveShell(undefined, { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' })
    if (windows) {
      expect(resolved.kind).toBe('cmd')
      expect(resolved.label).toContain('cmd.exe')
      /*
       * `undefined`, not the resolved path. `shell: true` is what has always run, and naming the
       * same thing explicitly would be a second way of saying it - the drift this repository
       * keeps paying for.
       */
      expect(resolved.command).toBeUndefined()
    } else {
      expect(resolved.kind).toBe('posix')
    }
  })

  it('honours a configured shell, which §16 always specified and nothing implemented', () => {
    expect(resolveShell('powershell.exe').kind).toBe('powershell')
    expect(resolveShell('pwsh').kind).toBe('pwsh')
    expect(resolveShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe').kind).toBe('pwsh')
    expect(resolveShell('/bin/zsh').kind).toBe('posix')
    // Whitespace only is not a choice.
    expect(resolveShell('   ').command).toBeUndefined()
  })

  it('names each shell the way somebody would say it', () => {
    expect(resolveShell('powershell.exe').label).toContain('5.1')
    expect(resolveShell('pwsh').label).toContain('PowerShell 7')
  })
})

describe('onPath', () => {
  it('finds an executable placed on a PATH it is given', () => {
    const name = windows ? 'lc-probe.exe' : 'lc-probe'
    fs.writeFileSync(path.join(scratch, name), '')
    expect(onPath('lc-probe', { PATH: scratch, PATHEXT: '.EXE' })).toBe(true)
  })

  it('does not mistake a directory for a program', () => {
    // `C:\tools\git\` would otherwise answer for `git`, and the guidance would then recommend a
    // tool that is not there - which is the whole fault this module exists to prevent.
    fs.mkdirSync(path.join(scratch, 'lc-probe'))
    expect(onPath('lc-probe', { PATH: scratch, PATHEXT: '.EXE' })).toBe(false)
  })

  it('answers false for a name that is nowhere', () => {
    expect(onPath('lc-definitely-not-installed', { PATH: scratch })).toBe(false)
  })
})

describe('detectCommandTools', () => {
  it('splits the list into what is here and what is not', () => {
    const detected = detectCommandTools({ PATH: scratch, PATHEXT: '.EXE' })
    expect(detected.present.length + detected.missing.length).toBeGreaterThan(5)
    // No overlap, or the guidance would both recommend and forbid the same tool.
    for (const name of detected.present) expect(detected.missing).not.toContain(name)
  })

  it('does not report the shell builtin of the platform as missing', () => {
    /*
     * `type` is a cmd builtin and `ls` a POSIX one, so PATH says nothing about either. Reporting
     * the commonest reading tool on each platform as absent would push the model off it for no
     * reason.
     */
    const detected = detectCommandTools({ PATH: scratch, PATHEXT: '.EXE' })
    expect(detected.present).toContain(windows ? 'type' : 'ls')
  })

  it('finds what this machine really has', () => {
    // Not a fixture: the point of the module is that it reports the real machine.
    const detected = detectCommandTools()
    expect(detected.present).toContain('git')
  })
})
