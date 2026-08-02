import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // `@vscode/ripgrep` must stay external: it resolves a real binary on disk via
  // `createRequire(import.meta.url)`, which esbuild stubs to `{}` in CJS output —
  // bundling it makes `rgPath` resolution throw at runtime on the first search.
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
}
