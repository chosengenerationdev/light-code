import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Renames `from` over `to`, riding out the moment another program holds `to` open.
 *
 * Every file this product owns is saved by writing a sibling and renaming it into place (§15), so a
 * crash leaves the old contents or the new, never half. On Windows that rename is refused —
 * `EPERM`, sometimes `EACCES` or `EBUSY` — while anything else has the target open, even for a
 * read: another VS Code window loading the same `config.json`, a file watcher, antivirus scanning
 * the write that just happened, OneDrive syncing the folder. Reported from real use as "sometimes
 * saving gives EPERM with the config name in it". It is momentary, which is why it was sometimes.
 *
 * So it is retried with a short backoff — the same answer `graceful-fs` (npm's own) gives — for up
 * to about three seconds, and only for those codes: a missing folder or a full disk will not get
 * better by waiting. If it still fails, the temporary file is removed so it does not pile up, and
 * the error names the file and the usual culprits instead of a bare errno.
 */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])
const DELAYS_MS = [20, 40, 80, 120, 200, 300, 400, 600, 800, 1000]

export class FileReplaceError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message)
    this.name = 'FileReplaceError'
  }
}

export async function replaceFile(
  from: string,
  to: string,
  options: { rename?: (from: string, to: string) => Promise<void>; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const rename = options.rename ?? ((a: string, b: string) => fs.rename(a, b))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const delay = DELAYS_MS[attempt]
      if (code !== undefined && TRANSIENT.has(code) && delay !== undefined) {
        await sleep(delay)
        continue
      }
      await fs.rm(from, { force: true }).catch(() => undefined)
      if (code !== undefined && TRANSIENT.has(code)) {
        throw new FileReplaceError(
          `Could not save ${path.basename(to)} (${to}): another program kept it open for several seconds (${code}). ` +
            'Usually another VS Code window, antivirus, or a sync tool such as OneDrive working on that folder. ' +
            'The previous contents are intact; try the save again.',
          code,
        )
      }
      throw error
    }
  }
}
