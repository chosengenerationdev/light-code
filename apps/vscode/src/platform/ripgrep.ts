import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@light-code/core'

/**
 * Locates the `rg` executable.
 *
 * Two sources, in order:
 *
 * 1. **`dist/bin/rg` inside the extension**, put there by `esbuild.mjs` at package time.
 *    This is what a published install uses. The binary is platform-specific, so the VSIX
 *    is built per target (`vsce package --target win32-x64`, …) and carries exactly one.
 * 2. **`@vscode/ripgrep`**, for running from source with <kbd>F5</kbd>, where `dist/bin`
 *    has not been populated.
 *
 * Why this is not simply an import in core: `@vscode/ripgrep` resolves its binary through
 * `createRequire(import.meta.url)`, so it cannot be bundled — it has to stay external, and
 * an external `require` in the bundle is only satisfiable if the package is inside the
 * VSIX. It is not. That combination made the *published* extension fail to activate at all
 * with `MODULE_NOT_FOUND`, while build, typecheck, and `vsce package` all succeeded.
 *
 * **The require below must stay inside this function.** An external import at module scope
 * is hoisted to a top-level `require` in the bundle, which is precisely the failure above;
 * a call expression in a function body stays where it is and can be caught.
 *
 * Returning `undefined` degrades the two ripgrep-backed tools with a clear message rather
 * than taking the extension down with it.
 */
export function resolveRipgrepPath(extensionPath: string, logger?: Logger): string | undefined {
  const bundled = path.join(extensionPath, 'dist', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
  if (fs.existsSync(bundled)) return bundled

  try {
    // Must stay a lazy call expression rather than an import: an import is hoisted to a
    // top-level require in the bundle, which is what broke activation for every install.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
    if (typeof rgPath === 'string' && fs.existsSync(rgPath)) return rgPath
    logger?.warn('@vscode/ripgrep resolved a path that does not exist', String(rgPath))
  } catch (error) {
    logger?.warn(
      'ripgrep was not found — list_files (recursive) and search_files are unavailable',
      error instanceof Error ? error.message : String(error),
    )
  }
  return undefined
}
