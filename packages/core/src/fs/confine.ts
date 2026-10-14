import fs from 'node:fs/promises'
import path from 'node:path'

export class PathConfinementError extends Error {
  constructor(
    readonly requestedPath: string,
    readonly root: string,
  ) {
    super(
      `"${requestedPath}" resolves outside the workspace root "${root}". ` +
        'To read files elsewhere — a network share, a log directory — add the folder under ' +
        'Settings → Approvals → Folders it may read.',
    )
    this.name = 'PathConfinementError'
  }
}

function normalizeForComparison(resolvedPath: string): string {
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
}

/**
 * Whether `target` is `root` or sits underneath it. Both must already be resolved.
 *
 * **Exported so it can be tested directly**, because the interesting cases are network shares
 * and drive roots and neither can be conjured up in a unit test. A test that re-implemented
 * this comparison would pass whatever the real code did — which is exactly how the bug below
 * survived a green suite.
 *
 * That bug: `path.resolve` leaves a trailing separator on any path that is *already* a root — a
 * UNC share root keeps it, and so does `D:\` — so the obvious `root + path.sep` produces a
 * doubled separator and nothing is ever contained by it. A share added under "Folders it may
 * read" therefore matched no file inside it, and the model, told the path lay outside the
 * workspace, kept suggesting the file be copied in.
 *
 * It only appears at a root, which is why ordinary folders worked and the one form people
 * actually type for a share did not.
 */
export function isWithinRoot(target: string, root: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (target === root) return true
  // Equal once the root's own trailing separator is discounted, so a share root contains itself.
  if (target + path.sep === prefix) return true
  return target.startsWith(prefix)
}

/**
 * Resolves symlinks and drive-relative/UNC/`\\?\`-prefixed paths as far as they exist.
 * Falls back to resolving the nearest existing ancestor for paths that don't exist yet
 * (e.g. a new file about to be written), so confinement can still be checked before creation.
 */
/**
 * Codes that mean "this path does not resolve here", as opposed to a real I/O failure.
 *
 * `ENOENT` is the ordinary one. The next group is what Windows returns for a UNC path whose host
 * is unreachable or whose share does not exist — `UNKNOWN` in particular, which does not read as a
 * missing-file code at all. Rethrowing those turned "I mistyped the server name" into an
 * unhandled error from inside a tool rather than a sentence about the path.
 *
 * ## `EPERM` and `EACCES`, added from a real report: "not able to read the file from shared path,
 * says not permitted"
 *
 * `fs.realpath` opens the file to resolve it, and on a corporate share that open is frequently
 * refused even where reading the file is not — measured here: an admin share and a protected
 * system file both give `EPERM: operation not permitted`, which is exactly the phrase the user
 * reported. Because it was not in this set it escaped `confine` as a raw errno, so
 * `resolveToolPath` rethrew it, **the out-of-workspace prompt never appeared**, and the user was
 * refused a file they could perfectly well read.
 *
 * ## What treating them as unresolvable costs, stated plainly
 *
 * The walk below resolves the nearest ancestor it *can* and appends the rest. For `ENOENT` that
 * loses nothing, because a path that does not exist cannot be a symlink. For `EPERM` it can: a
 * symlink whose own resolution is refused but whose target is readable would be judged by where
 * it sits rather than where it points, which is the check this whole file exists to perform.
 *
 * It is accepted because the alternative is worse in both directions. The path still goes through
 * containment against the allowed roots, still hits the deny list (invariant 6, checked before
 * anything is offered), and still needs explicit approval if it lands outside — so nothing is
 * silently allowed. Before this change none of those ran at all, because the error escaped first.
 */
const UNRESOLVABLE_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'UNKNOWN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPERM',
  'EACCES',
])

/** `\\host\share\rest` (or `\\?\UNC\host\share\rest`) split up, lower-cased; undefined if not UNC. */
function uncParts(p: string): { host: string; share: string } | undefined {
  const plain = p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/\//g, '\\')
  const match = /^\\\\([^\\]+)\\([^\\]+)/.exec(plain)
  return match === null ? undefined : { host: (match[1] ?? '').toLowerCase(), share: (match[2] ?? '').toLowerCase() }
}

/** Whether a drive letter is a mapped network drive: its root resolves to a UNC path. Asked once per drive. */
const networkDrives = new Map<string, Promise<boolean>>()
function isNetworkDrive(p: string): Promise<boolean> {
  const drive = /^([a-z]):/i.exec(p)?.[1]?.toLowerCase()
  if (process.platform !== 'win32' || drive === undefined) return Promise.resolve(false)
  let known = networkDrives.get(drive)
  if (known === undefined) {
    known = fs.realpath(`${drive}:\\`).then((real) => uncParts(real) !== undefined, () => false)
    networkDrives.set(drive, known)
  }
  return known
}

/**
 * A network path whose resolution lands on a *different server or share* is kept as written.
 *
 * Reported from real use: a DFS share was "access denied" while a plain NAS share worked, for a user who
 * owns the share. A DFS path is a referral - `\\corp\dfs\team\x` is served by, say, `\\fs01\team$\x` - and
 * `realpath` answers with the target. Every tool then opened the target directly, which DFS
 * permissions, a hidden `$` share or the server's own name can refuse while the namespace path works;
 * a NAS share has no referral, which is why it was unaffected. A mapped drive letter onto DFS resolves
 * the same way.
 *
 * Symlink containment is unchanged where it matters: a local path (a link in the workspace pointing at a
 * share) and a link within the same share are still judged by where they land. Only a hop that the
 * network itself made - to another server or share - is not followed, and the deny list and the
 * credential floor still see the path.
 */
async function asWrittenWhenRedirected(requested: string, real: string): Promise<string> {
  const target = uncParts(real)
  if (target === undefined) return real
  const asked = uncParts(requested)
  if (asked !== undefined) {
    return asked.host === target.host && asked.share === target.share ? real : path.resolve(requested)
  }
  // A drive letter that resolved to UNC: a mapped network drive, kept as the letter the user gave.
  return (await isNetworkDrive(requested)) ? path.resolve(requested) : real
}

async function realpathAllowingMissing(target: string): Promise<string> {
  try {
    return await asWrittenWhenRedirected(target, await fs.realpath(target))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (!UNRESOLVABLE_CODES.has(code)) throw error
    const parent = path.dirname(target)
    if (parent === target) {
      /*
       * Nothing left to walk up to. Returning the path as given lets confinement decide, which
       * for an unreachable UNC host is the right answer: refused as outside every root, with
       * the ordinary message, rather than a raw errno escaping from inside a tool.
       */
      return path.resolve(target)
    }
    const realParent = await realpathAllowingMissing(parent)
    return path.join(realParent, path.basename(target))
  }
}

/**
 * Confines `requestedPath` to `root`: resolves symlinks *and* compares case-insensitively
 * on Windows. Prefix-matching the *unresolved* path is the classic bug this avoids —
 * see CLAUDE.md §16. Throws `PathConfinementError` if the resolved path escapes root.
 */
export async function confine(requestedPath: string, root: string): Promise<string> {
  return confineToAny(requestedPath, [root])
}

/**
 * Confines to the first of several roots that contains the path.
 *
 * The extra roots exist for reading outside the workspace — a network share full of logs is the
 * case that prompted it, and on Windows that is a UNC path which no amount of workspace-relative
 * resolution will ever reach.
 *
 * Every root is realpath'd, so a symlink inside the workspace pointing at a share is judged by
 * where it lands rather than where it sits. `roots` must already be the *allowed* set: this
 * function decides containment, never policy.
 */
export async function confineToAny(requestedPath: string, roots: readonly string[]): Promise<string> {
  const realTarget = await realpathAllowingMissing(requestedPath)
  const normalizedTarget = normalizeForComparison(path.resolve(realTarget))

  for (const root of roots) {
    let realRoot: string
    try {
      // Kept as written on the same terms as the target, or a DFS root would contain nothing given as DFS.
      realRoot = await asWrittenWhenRedirected(root, await fs.realpath(root))
    } catch {
      // A configured share that is not mounted right now is skipped rather than fatal — the
      // other roots still work, and the path simply will not match this one.
      continue
    }
    const normalizedRoot = normalizeForComparison(path.resolve(realRoot))
    if (isWithinRoot(normalizedTarget, normalizedRoot)) return realTarget
  }

  throw new PathConfinementError(requestedPath, roots[0] ?? '')
}

export { realpathAllowingMissing, normalizeForComparison, asWrittenWhenRedirected }
