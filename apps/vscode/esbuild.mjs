import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

/**
 * `--target` names the VSIX platform to build for, e.g. `--target=win32-x64`. It decides
 * which ripgrep binary is copied into `dist/bin`. Omitted means "this machine", which is
 * what a local F5 run wants.
 */
const targetArg = process.argv.find((arg) => arg.startsWith('--target='))
const target = targetArg?.slice('--target='.length) ?? `${process.platform}-${process.arch}`

/**
 * ripgrep ships as one npm package per platform. The binary is copied into `dist/bin` at
 * build time and located at runtime by `platform/ripgrep.ts`.
 *
 * It cannot simply be imported from core: the package resolves its binary through
 * `createRequire(import.meta.url)`, so it must stay external to esbuild — and an external
 * `require` is only satisfiable if the package is inside the VSIX, which it is not under
 * `vsce package --no-dependencies`. That combination shipped an extension that failed to
 * activate at all, while build, typecheck and package all passed.
 */
async function copyRipgrepBinary() {
  const outDir = path.join('dist', 'bin')
  const executable = target.startsWith('win32') ? 'rg.exe' : 'rg'
  const destination = path.join(outDir, executable)

  // Cleared first: building linux then win32 in the same tree would otherwise leave both
  // binaries behind, and every VSIX would carry 5MB of another platform's ripgrep.
  fs.rmSync(outDir, { recursive: true, force: true })

  const source = locateRipgrepBinary(target, executable)
  if (source === undefined) {
    console.warn(
      `[esbuild] no ripgrep binary for ${target}; dist/bin left empty.\n` +
        '          A local run falls back to @vscode/ripgrep, but a VSIX built now would\n' +
        '          ship without search. Run `node scripts/fetch-ripgrep.mjs` first.',
    )
    return
  }

  fs.mkdirSync(outDir, { recursive: true })
  fs.copyFileSync(source, destination)
  // The archive loses the executable bit on non-Windows targets.
  if (!target.startsWith('win32')) fs.chmodSync(destination, 0o755)
  console.log(`[esbuild] ripgrep for ${target} -> ${destination}`)
}

function locateRipgrepBinary(platformTarget, executable) {
  const candidates = [
    // Fetched by scripts/fetch-ripgrep.mjs for cross-platform packaging.
    path.join('..', '..', '.ripgrep-cache', platformTarget, executable),
    // Installed locally as an optional dependency — only ever the current platform.
    path.join('..', '..', 'node_modules', '@vscode', `ripgrep-${platformTarget}`, 'bin', executable),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  // Building for this machine: ask `@vscode/ripgrep` itself. It already knows how to find
  // its binary through pnpm's `.pnpm` layout, which a hand-built path does not.
  if (platformTarget === `${process.platform}-${process.arch}`) {
    try {
      const resolved = execFileSync(
        process.execPath,
        ['-e', "process.stdout.write(require('@vscode/ripgrep').rgPath)"],
        { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      if (resolved.length > 0 && fs.existsSync(resolved)) return resolved
    } catch {
      // Not installed — normal in CI before scripts/fetch-ripgrep.mjs has run.
    }
  }
  return undefined
}

const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // `@vscode/ripgrep` stays external because it resolves a binary via
  // `createRequire(import.meta.url)`, which esbuild cannot bundle. What changed is *where*
  // it is required: `platform/ripgrep.ts` calls it lazily inside a function, so a packaged
  // install (where the package is absent) degrades instead of failing to activate.
  external: ['vscode', '@vscode/ripgrep'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
})

// The webview runs in an isolated browser context with no access to node_modules —
// React and everything else must be inlined, and nothing here may reach `vscode`.
const webviewCtx = await esbuild.context({
  entryPoints: ['../../packages/ui/src/main.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
})

const contexts = [extensionCtx, webviewCtx]

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()))
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()))
  await Promise.all(contexts.map((ctx) => ctx.dispose()))
  await copyRipgrepBinary()
}
