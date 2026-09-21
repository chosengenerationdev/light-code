import fs from 'node:fs'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { packSource } from './sourcePack.mjs'

/**
 * Two bundles with very different rules.
 *
 * ## The server bundles its dependencies *and* its assets, deliberately
 *
 * It used to leave dependencies external on the reasoning that npm installs them anyway. That is
 * true where npm can reach a registry — and false in exactly the environment this product is built
 * for. Behind a corporate proxy with no mirror for these packages, a tarball with five runtime
 * dependencies is not installable at all, and "download it from npmjs and install it locally"
 * silently means "and also fetch five more things".
 *
 * The browser bundle and the guide diagrams are inlined for the same reason taken one step
 * further: with them in, `dist/cli.js` needs *nothing beside it*, which is what makes
 * `--export-pkg` possible — one file, copied to a machine that has Node and no registry.
 *
 * `@vscode/ripgrep` stays external because it resolves a *binary* on disk, and bundling it breaks
 * that lookup — which is precisely how a VSIX once shipped that could not activate (§19). It is
 * optional at runtime: without it two search tools degrade with a clear message instead of the
 * server failing to start, which is exactly what an exported single file gets.
 *
 * ## CommonJS, not ESM
 *
 * So that `node light-code-pkg` works whatever the file is called. Node decides a file's module
 * kind from its extension, and an extensionless or `.js` file is CommonJS — an ESM bundle under
 * either name fails with "Cannot use import statement outside a module", which is a baffling
 * error for somebody who was handed a file and told to run it. CommonJS runs under every name.
 *
 * Nothing was lost in the move: the `require` shim the ESM build needed is native here, and the
 * one use of `import.meta.url` went away when the assets stopped being read from disk.
 */
const outDir = 'dist'

/*
 * The published version, baked in.
 *
 * Read from the manifest here rather than at runtime because the bundle has no `package.json`
 * beside it to read — the same reason the operator guide and the Python worker are inlined. A
 * `__LC_VERSION__` that survived into the output unreplaced would be a visible bug rather than a
 * silent one, which is the right way round.
 */
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))

/*
 * The client is built FIRST now.
 *
 * The server inlines what this produces, so the order is a dependency rather than a preference.
 * Built the other way round the server would bake whatever the previous build left behind, which
 * is the kind of staleness that shows up as an old UI against new server code and sends somebody
 * hunting through the wrong half.
 */
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

/*
 * The guide's diagrams, copied from the extension.
 *
 * They are generated once, by `scripts/generate-walkthrough-art.mjs`, and both hosts show the
 * same tour. The files are checked in under `apps/vscode` because a VSIX can only contain what
 * sits beneath the extension root and `contributes.walkthroughs` names them at a fixed path —
 * so the extension is where they must live, and the browser copies rather than the reverse.
 *
 * Missing art is a warning, not a failure: the server should still start. The guide degrades to
 * text, which is worth far more than a build that will not produce a server.
 */
const artDir = path.join('..', 'vscode', 'walkthrough', 'media')
const guideOut = path.join(outDir, 'client', 'guide')
if (fs.existsSync(artDir)) {
  fs.mkdirSync(guideOut, { recursive: true })
  let copied = 0
  for (const file of fs.readdirSync(artDir)) {
    if (!file.endsWith('.svg')) continue
    fs.copyFileSync(path.join(artDir, file), path.join(guideOut, file))
    copied++
  }
  console.log(`[esbuild] guide art: ${String(copied)} files`)
} else {
  console.warn('[esbuild] no guide art found — the guide will render without diagrams')
}

/**
 * Everything the browser will ask for, as `name -> base64`.
 *
 * Source maps are deliberately left out: they are the largest files here by some way, nobody
 * debugging a corporate desktop has the sources to match them against, and the point of this map
 * is a file somebody can carry.
 */
function collectClientAssets() {
  const root = path.join(outDir, 'client')
  const assets = {}
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, name)
      else if (!entry.name.endsWith('.map')) assets[name] = fs.readFileSync(full).toString('base64')
    }
  }
  walk(root, '')
  return assets
}

/**
 * Swaps the committed stub for the real map.
 *
 * A plugin rather than a generated file on disk, because the real map is well over a megabyte of
 * base64 and would otherwise be committed and re-committed on every change to the UI. The stub is
 * a real module so `tsc` has something to check, and `clientAssets.test.ts` fails if it ever stops
 * being empty in the repository.
 */
const inlineSource = {
  name: 'inline-source-pack',
  setup(build) {
    const stub = path.resolve('src', 'generated', 'sourcePack.ts')
    build.onLoad({ filter: /sourcePack\.ts$/ }, (args) => {
      if (path.resolve(args.path) !== stub) return null
      const repoRoot = path.resolve('..', '..')
      const packed = packSource(repoRoot)
      console.log(
        `[esbuild] inlined ${String(packed.count)} source files ` +
          `(${String(Math.round(packed.rawBytes / 1024))} KB -> ` +
          `${String(Math.round(packed.packedBytes / 1024))} KB gzipped)`,
      )
      return { contents: `export const SOURCE_PACK = ${JSON.stringify(packed.base64)}`, loader: 'ts' }
    })
  },
}

const inlineClientAssets = {
  name: 'inline-client-assets',
  setup(build) {
    const stub = path.resolve('src', 'generated', 'clientAssets.ts')
    build.onLoad({ filter: /clientAssets\.ts$/ }, (args) => {
      if (path.resolve(args.path) !== stub) return null
      const assets = collectClientAssets()
      const names = Object.keys(assets)
      const bytes = names.reduce((total, name) => total + assets[name].length, 0)
      console.log(
        `[esbuild] inlined ${String(names.length)} client assets (${String(Math.round(bytes / 1024))} KB base64)`,
      )
      return {
        contents: `export const CLIENT_ASSET_BYTES = ${JSON.stringify(assets)}`,
        loader: 'ts',
      }
    })
  },
}

await esbuild.build({
  entryPoints: ['src/cli.ts', 'src/server.ts'],
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node17',
  sourcemap: true,
  // Workspace packages are bundled (they are not published); real dependencies are too, so the
  // output needs no `node_modules` at all. See the note at the top.
  external: ['@vscode/ripgrep'],
  logLevel: 'info',
  plugins: [inlineClientAssets, inlineSource],
  /*
   * `.cjs`, not `.js`.
   *
   * This package is `"type": "module"`, so a `.js` file inside it is ESM whatever esbuild
   * produced — Node reads the nearest package.json before it reads the file. The extension is
   * what makes the output actually run here. An *exported* copy is a different matter: it lands
   * outside any package, where an extensionless name is CommonJS and works as written.
   */
  outExtension: { '.js': '.cjs' },
  define: { __LC_VERSION__: JSON.stringify(version) },
})

console.log('[esbuild] host built')
