import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRipgrepResolver, siblingRipgrep, vscodeRipgrepCandidates } from './ripgrep.js'

/**
 * Ripgrep going missing mid-session.
 *
 * Reported from real use: `search_files` failing intermittently with `rg.exe ENOENT`, and coming
 * back after a window reload. The path was resolved once at activation, on the written assumption
 * that it could not change while running — but a VS Code extension lives in a version-stamped
 * folder, and installing a newer build writes a new one, marks the old in `.obsolete` and deletes
 * it while this extension host carries on holding an absolute path into it.
 *
 * Every test here works on a real directory tree, because the whole defect is a file ceasing to
 * exist and nothing that stubs the filesystem can be wrong about that in the same way.
 */

const roots: string[] = []
const EXE = process.platform === 'win32' ? 'rg.exe' : 'rg'
/** The binaries here are placeholder files, so starting one is stubbed rather than attempted. */
const RUNS = { canRun: (): boolean => true }

const makeExtensions = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ext-'))
  roots.push(root)
  return root
}

const install = (root: string, version: string): string => {
  const dir = path.join(root, `chosengeneration.light-code-vscode-${version}`)
  fs.mkdirSync(path.join(dir, 'dist', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'dist', 'bin', EXE), 'not really ripgrep')
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('the ripgrep resolver', () => {
  it('finds the binary in its own install', () => {
    const root = makeExtensions()
    const resolve = createRipgrepResolver(install(root, '0.86.0'), undefined, RUNS)
    expect(resolve()).toBe(path.join(root, 'chosengeneration.light-code-vscode-0.86.0', 'dist', 'bin', EXE))
  })

  /*
   * The bug, in one test: the answer from activation is still held, and the folder it names has
   * been deleted by an update. Before this it was returned anyway and reached `spawn` as ENOENT.
   */
  it('recovers when an update deletes the folder it was using', () => {
    const root = makeExtensions()
    const old = install(root, '0.83.0')
    const resolve = createRipgrepResolver(old, undefined, RUNS)
    expect(resolve()).toContain('0.83.0')

    install(root, '0.86.0')
    fs.rmSync(old, { recursive: true, force: true })

    const recovered = resolve()
    expect(recovered).toContain('0.86.0')
    expect(fs.existsSync(recovered ?? '')).toBe(true)
  })

  it('does not go looking while its own binary is still there', () => {
    const root = makeExtensions()
    install(root, '0.90.0')
    const resolve = createRipgrepResolver(install(root, '0.86.0'), undefined, RUNS)
    expect(resolve()).toContain('0.86.0')
  })

  /* A string sort puts 0.9.0 above 0.86.0 and would pick up an ancient build. */
  it('prefers the newest sibling numerically, not alphabetically', () => {
    const root = makeExtensions()
    const old = install(root, '0.83.0')
    install(root, '0.9.0')
    install(root, '0.86.0')
    fs.rmSync(old, { recursive: true, force: true })
    expect(siblingRipgrep(old, EXE)).toContain('0.86.0')
  })

  it('reports nothing rather than guessing when no install has one', () => {
    const root = makeExtensions()
    const dir = path.join(root, 'chosengeneration.light-code-vscode-0.86.0')
    fs.mkdirSync(dir, { recursive: true })
    expect(siblingRipgrep(dir, EXE)).toBeUndefined()
  })

  /* Another publisher's extension is not ours to borrow from. */
  it('never takes a binary from an unrelated extension', () => {
    const root = makeExtensions()
    const other = path.join(root, 'someone.else-1.0.0', 'dist', 'bin')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, EXE), 'not ours')
    const gone = path.join(root, 'chosengeneration.light-code-vscode-0.86.0')
    expect(siblingRipgrep(gone, EXE)).toBeUndefined()
  })

  /* The happy path must not pay for the recovery: one stat per call, no directory scan. */
  it('keeps answering after the first resolution without re-reading the directory', () => {
    const root = makeExtensions()
    const resolve = createRipgrepResolver(install(root, '0.86.0'), undefined, RUNS)
    const first = resolve()
    expect(resolve()).toBe(first)
    expect(resolve()).toBe(first)
  })

  /*
   * Present but refused. Managed Windows machines commonly block programs under the user
   * profile, which is where extensions live, so our rg.exe exists and never starts. VS Code's
   * own copy is under its install folder and is allowed, or VS Code's search would not work.
   */
  it('skips a binary that exists but will not start, and uses the one VS Code ships', () => {
    const root = makeExtensions()
    const ours = install(root, '0.86.0')
    const appRoot = path.join(root, 'vscode', 'resources', 'app')
    const bundled = vscodeRipgrepCandidates(appRoot, EXE)[0]!
    fs.mkdirSync(path.dirname(bundled), { recursive: true })
    fs.writeFileSync(bundled, 'VS Code ripgrep')

    const tried: string[] = []
    const resolve = createRipgrepResolver(ours, undefined, {
      appRoot,
      canRun: (candidate) => {
        tried.push(candidate)
        return !candidate.startsWith(ours)
      },
    })
    expect(resolve()).toBe(bundled)
    // Asked once per path: a refused binary is not re-tried on every turn.
    resolve()
    expect(tried.filter((candidate) => candidate.startsWith(ours))).toHaveLength(1)
  })

  it('reports nothing when every binary is refused, so the built-in search takes over', () => {
    const root = makeExtensions()
    const resolve = createRipgrepResolver(install(root, '0.86.0'), undefined, { canRun: () => false })
    expect(resolve()).toBeUndefined()
  })
})
