import fs from 'node:fs'
import path from 'node:path'
import * as esbuild from 'esbuild'

/**
 * Two bundles with very different rules.
 *
 * ## The server bundles its dependencies, deliberately
 *
 * It used to leave them external on the reasoning that npm installs them anyway. That is true
 * where npm can reach a registry — and false in exactly the environment this product is built
 * for. Behind a corporate proxy with no mirror for these packages, a tarball with five runtime
 * dependencies is not installable at all, and "download it from npmjs and install it locally"
 * silently means "and also fetch five more things".
 *
 * Bundled, the published tarball installs with no network at all, and the extracted folder
 * runs with `node dist/cli.js` and no `node_modules` whatsoever. Verified by deleting them.
 *
 * `@vscode/ripgrep` stays external because it resolves a *binary* on disk, and bundling it
 * breaks that lookup — which is precisely how a VSIX once shipped that could not activate
 * (§19). It is optional at runtime: without it two search tools degrade with a clear message
 * instead of the server failing to start.
 *
 * The client is a browser bundle of packages/ui. It is bundled and self-contained because
 * invariant 4 forbids remote assets: everything the page loads comes from this server.
 */
const outDir = 'dist'

await esbuild.build({
  entryPoints: ['src/cli.ts', 'src/server.ts'],
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  // Workspace packages are bundled (they are not published); real dependencies are not.
  external: ['@vscode/ripgrep'],
  logLevel: 'info',
  banner: {
    // The bundle is ESM but core reaches for `require` to locate ripgrep lazily, which ESM
    // does not define. Recreating it here is the standard shim.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
})

await esbuild.build({
  entryPoints: { client: 'src/client/main.tsx' },
  outdir: path.join(outDir, 'client'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  minify: true,
  logLevel: 'info',
})

for (const asset of ['index.html', 'client.css']) {
  fs.copyFileSync(path.join('src', 'client', asset), path.join(outDir, 'client', asset))
}
console.log('[esbuild] host built')
