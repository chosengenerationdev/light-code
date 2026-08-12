import fs from 'node:fs'
import path from 'node:path'
import * as esbuild from 'esbuild'

/**
 * Two bundles with very different rules.
 *
 * The server is Node ESM with its dependencies left external — it is installed from npm,
 * so `node_modules` is present at runtime and bundling would only make `@vscode/ripgrep`'s
 * binary lookup break the way it once did in the extension.
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
  external: ['@vscode/ripgrep', 'env-paths', '@modelcontextprotocol/sdk', 'undici', 'zod'],
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
