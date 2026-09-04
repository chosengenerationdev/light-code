import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { confine, confineToAny, isWithinRoot, PathConfinementError } from './confine.js'

// Symlink creation needs a privilege Windows doesn't grant by default (Developer Mode
// or admin) — probe once, synchronously, so `it.skipIf` can gate the relevant test.
const symlinkProbeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'lc-symlink-probe-'))
let symlinksSupported = true
try {
  fsSync.symlinkSync(path.join(symlinkProbeDir, 'target'), path.join(symlinkProbeDir, 'link'))
} catch {
  symlinksSupported = false
}
fsSync.rmSync(symlinkProbeDir, { recursive: true, force: true })

describe('confine', () => {
  let root: string
  let outside: string

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-confine-root-'))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-confine-outside-'))
    await fs.writeFile(path.join(root, 'inside.txt'), 'inside')
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    if (symlinksSupported) {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape-link.txt'))
    }
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  it('allows a file directly inside the root', async () => {
    const result = await confine(path.join(root, 'inside.txt'), root)
    expect(path.basename(result)).toBe('inside.txt')
  })

  it('rejects ../ traversal outside the root', async () => {
    const traversal = path.join(root, '..', path.basename(outside), 'secret.txt')
    await expect(confine(traversal, root)).rejects.toThrow(PathConfinementError)
  })

  it('rejects an absolute path outside the root', async () => {
    await expect(confine(path.join(outside, 'secret.txt'), root)).rejects.toThrow(PathConfinementError)
  })

  it.skipIf(!symlinksSupported)(
    'rejects a symlink inside the root that resolves outside it',
    async () => {
      await expect(confine(path.join(root, 'escape-link.txt'), root)).rejects.toThrow(
        PathConfinementError,
      )
    },
  )

  it('allows a nonexistent path inside the root (about to be written)', async () => {
    const result = await confine(path.join(root, 'new-file.txt'), root)
    expect(path.basename(result)).toBe('new-file.txt')
  })

  it('rejects a nonexistent path outside the root', async () => {
    await expect(confine(path.join(outside, 'new-file.txt'), root)).rejects.toThrow(
      PathConfinementError,
    )
  })
})

/**
 * Reading outside the workspace, by explicit configuration.
 *
 * The case that prompted it: logs on a network share. On Windows that is a UNC path, which no
 * amount of workspace-relative resolution will ever reach — so it has to be an allowed root or
 * it is unreachable entirely.
 */
describe('confineToAny', () => {
  let workspace: string
  let elsewhere: string

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-ws-'))
    elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-share-'))
    await fs.writeFile(path.join(elsewhere, 'app.log'), 'entries', 'utf8')
    await fs.writeFile(path.join(workspace, 'a.ts'), 'code', 'utf8')
  })
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
    await fs.rm(elsewhere, { recursive: true, force: true })
  })

  it('allows a path inside any listed root', async () => {
    const target = path.join(elsewhere, 'app.log')
    await expect(confineToAny(target, [workspace, elsewhere])).resolves.toContain('app.log')
  })

  it('still allows the workspace', async () => {
    await expect(confineToAny(path.join(workspace, 'a.ts'), [workspace, elsewhere])).resolves.toContain('a.ts')
  })

  /** The default remains confinement: an unlisted folder is refused exactly as before. */
  it('refuses a path in no listed root', async () => {
    await expect(confineToAny(path.join(elsewhere, 'app.log'), [workspace])).rejects.toBeInstanceOf(
      PathConfinementError,
    )
  })

  /** A share that is not mounted must not take the other roots down with it. */
  it('skips a root that cannot be resolved', async () => {
    const missing = path.join(elsewhere, 'not-mounted')
    await expect(confineToAny(path.join(workspace, 'a.ts'), [missing, workspace])).resolves.toContain('a.ts')
  })

  it('names a way forward when it refuses', async () => {
    await expect(confineToAny(path.join(elsewhere, 'app.log'), [workspace])).rejects.toThrow(/Settings → Approvals/)
  })
})

/**
 * Roots that are themselves roots.
 *
 * `path.resolve` keeps a trailing separator on a UNC share root and on a drive root, so the
 * obvious `root + path.sep` prefix has two separators and matches nothing. That made every
 * network share added under "Folders it may read" silently useless — the exact case the
 * feature was built for, and the model, told the path was outside the workspace, kept
 * suggesting the file be copied in.
 *
 * String-level, because the real thing needs a mounted share.
 */
describe('containment against a root with a trailing separator', () => {
  const onWindows = process.platform === 'win32'
  const norm = (value: string): string => (onWindows ? value.toLowerCase() : value)

  /*
   * Calls the shipped predicate, not a copy of it. Re-implementing the comparison here would
   * make the test agree with itself rather than with the code, which is precisely how the
   * trailing-separator bug survived a green suite the first time.
   */
  const contains = (root: string, target: string): boolean =>
    isWithinRoot(norm(path.resolve(target)), norm(path.resolve(root)))

  // Built from a constant rather than written inline: a UNC literal is four backslashes deep
  // and every layer between here and the file has eaten some of them at least once.
  const B = '\\'
  const share = `${B}${B}server${B}share`

  it.runIf(onWindows)('a UNC share root contains files under it', () => {
    expect(contains(share, `${share}${B}logs${B}a.log`)).toBe(true)
    // The same root as the user would paste it, with a trailing separator.
    expect(contains(`${share}${B}`, `${share}${B}a.log`)).toBe(true)
  })

  it.runIf(onWindows)('a drive root contains files under it', () => {
    expect(contains(`D:${B}`, `D:${B}a.txt`)).toBe(true)
  })

  it.runIf(onWindows)('a share root does not contain a different share', () => {
    expect(contains(share, `${B}${B}server${B}other${B}a.log`)).toBe(false)
    expect(contains(share, `${B}${B}other${B}share${B}a.log`)).toBe(false)
  })

  it('an ordinary folder still does not match a sibling with a shared prefix', () => {
    const base = path.resolve('/tmp/lc-root')
    expect(contains(base, `${base}-other/a.txt`)).toBe(false)
    expect(contains(base, path.join(base, 'a.txt'))).toBe(true)
  })
})

/**
 * A path whose *resolution* is refused, which is not the same as a path that is not there.
 *
 * Reported from real use: "not able to read the file from shared path, says not permitted". On a
 * corporate share `fs.realpath` is frequently refused even where reading the file is not —
 * measured on Windows, an admin share and a protected system file both give
 * `EPERM: operation not permitted`, which is the phrase that reached the user verbatim.
 *
 * Because `EPERM` was not among the unresolvable codes it escaped `confine` as a raw errno,
 * `resolveToolPath` rethrew it, and the out-of-workspace prompt never appeared — so the user was
 * refused a file they could have read, with no way to say yes to it.
 *
 * The failure is injected rather than staged against a real share: the interesting condition is
 * the error code, and no share can be conjured up in a unit test. Only the *target* is made to
 * fail, so the roots still resolve exactly as they do in production.
 */
describe('a path whose resolution is refused by permissions', () => {
  let root: string
  let target: string

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-eperm-root-')))
    target = path.join(root, 'share', 'book.xlsx')
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function refuseTarget(code: string): void {
    const real = fs.realpath.bind(fs)
    vi.spyOn(fs, 'realpath').mockImplementation((async (candidate: string, ...rest: unknown[]) => {
      if (path.resolve(String(candidate)) === path.resolve(target)) {
        const error = new Error(`${code}: operation not permitted, realpath '${String(candidate)}'`) as NodeJS.ErrnoException
        error.code = code
        throw error
      }
      return real(candidate as never, ...(rest as []))
    }) as never)
  }

  for (const code of ['EPERM', 'EACCES']) {
    it(`resolves a contained ${code} path instead of throwing the errno`, async () => {
      refuseTarget(code)
      await expect(confine(target, root)).resolves.toBe(target)
    })

    it(`still refuses a ${code} path outside every root`, async () => {
      refuseTarget(code)
      const elsewhere = path.resolve(root, '..', 'lc-eperm-elsewhere', 'book.xlsx')
      await expect(confine(elsewhere, root)).rejects.toThrow(PathConfinementError)
    })
  }

  /**
   * The line that keeps the change honest: a genuine I/O failure is still an I/O failure. Only
   * "I cannot resolve this here" becomes a containment decision the caller can act on.
   */
  it('does not swallow a real I/O error', async () => {
    refuseTarget('EIO')
    await expect(confine(target, root)).rejects.toThrow(/EIO/)
  })
})
