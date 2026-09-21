/**
 * The Node half of this repository, baked into the bundle.
 *
 * **This file is a stub in the repository and is replaced at build time**, by the same plugin in
 * `esbuild.mjs` that inlines the browser assets. It is a real module so `tsc` has something to
 * check, and deliberately empty so that two megabytes of base64 never land in a commit —
 * `sourcePack.test.ts` fails if it stops being empty.
 *
 * It exists because of where this product is used: somebody who cannot reach GitHub from the
 * office still has to be able to work on it. With the source in, the single file `--export-pkg`
 * writes is both the application and everything needed to rebuild it, which is one thing to carry
 * rather than two — and in an environment where nothing can be downloaded, that difference is the
 * whole feature.
 *
 * Gzipped whole and base64'd; see `sourcePack.mjs` for what is included and why.
 */
export const SOURCE_PACK = ''
