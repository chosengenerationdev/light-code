import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * The source that travels with the bundle, so it can be worked on somewhere GitHub cannot be
 * reached.
 *
 * Asked for directly: *"i dont have access to github in my office ... export this whole node
 * related code and continue the development in office"*. Baked into the bundle rather than kept
 * beside it so that the single file `--export-pkg` produces is **both the application and its own
 * source** — one thing to carry, which is the whole point when nothing else can be downloaded.
 *
 * ## What travels, and what does not
 *
 * Everything the Node host needs to install, build, typecheck and test:
 *
 * - `apps/host`, and the two workspace packages it is built from;
 * - the root manifests and the lockfile, so `pnpm install` resolves the same versions rather than
 *   whatever is newest on the mirror that day;
 * - `scripts/`, because the build runs several of them.
 *
 * `apps/vscode` is left out — this is the Node half — and so is every generated or heavy artefact:
 * `node_modules`, `dist`, `.git`, the animations in `docs/gifs` (13 MB of them), packaged VSIXes
 * and source maps. Excluding by *directory name* rather than by path so a nested `node_modules`
 * cannot slip through on one branch of the tree and not another.
 *
 * ## Why the exclusions are here and not in the plugin
 *
 * One owner. `esbuild.mjs` bakes what this returns and `sourcePack.test.ts` asserts what it
 * contains, so a rule that stopped matching would fail a test rather than quietly shipping a
 * hundred megabytes of `node_modules` inside the CLI.
 */

/** Roots, relative to the repository. A file is as valid an entry as a directory. */
export const SOURCE_ROOTS = [
  'apps/host',
  'packages/core',
  'packages/ui',
  'scripts',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'vitest.config.ts',
  '.gitattributes',
  'docs/hosting.md',
  'LICENSE',
]

/** Never descended into, wherever they appear. */
export const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.turbo',
  'coverage',
  // 13 MB of animations. They are documentation of the product, not part of building it.
  'gifs',
])

/**
 * Never packed, whatever directory they are in.
 *
 * `.tsbuildinfo` is the one that is not obvious and cost a debugging round. It is TypeScript's
 * record of what it has already compiled, and `composite` projects consult it before doing any
 * work — so a packed one made `tsc` report success and emit **nothing**, leaving `packages/core`
 * with no `dist` and `packages/ui` unable to resolve `@light-code/core/browser`. The error
 * pointed at a module that was plainly present, which is the worst kind: it sends you looking at
 * the import rather than at the build.
 *
 * Found by actually building the exported tree. No inspection of the file list would have shown
 * it, because the file looks like configuration.
 */
const SKIP_EXTENSIONS = new Set([
  '.vsix',
  '.gif',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.map',
  '.tgz',
  '.tsbuildinfo',
])

/**
 * Every packable file under the roots, as `repo-relative path -> contents`.
 *
 * Paths use forward slashes whatever produced them, so a pack made on Windows unpacks the same
 * way on Linux — §16's rule applied to something that crosses machines by design.
 */
export function collectSource(repoRoot) {
  const files = {}

  const add = (absolute) => {
    if (SKIP_EXTENSIONS.has(path.extname(absolute).toLowerCase())) return
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/')
    files[relative] = fs.readFileSync(absolute, 'utf8')
  }

  const walk = (absolute) => {
    const stat = fs.statSync(absolute)
    if (!stat.isDirectory()) {
      add(absolute)
      return
    }
    if (SKIP_DIRECTORIES.has(path.basename(absolute))) return
    for (const entry of fs.readdirSync(absolute)) walk(path.join(absolute, entry))
  }

  for (const root of SOURCE_ROOTS) {
    const absolute = path.join(repoRoot, root)
    if (fs.existsSync(absolute)) walk(absolute)
  }
  return files
}

/**
 * The pack, as one base64 string.
 *
 * Gzipped **whole** rather than per file: the tree is six megabytes of text with a great deal in
 * common between files, and compressing it as one stream gets it under two where compressing each
 * separately would not come close.
 */
export function packSource(repoRoot) {
  const files = collectSource(repoRoot)
  const json = JSON.stringify(files)
  const gzipped = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 })
  return {
    base64: gzipped.toString('base64'),
    count: Object.keys(files).length,
    rawBytes: json.length,
    packedBytes: gzipped.length,
  }
}
