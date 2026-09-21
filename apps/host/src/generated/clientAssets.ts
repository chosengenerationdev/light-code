/**
 * The browser bundle, baked into the server bundle.
 *
 * **This file is a stub in the repository and is replaced at build time**, by a plugin in
 * `esbuild.mjs` that reads whatever the client build just produced. It is a real file rather than
 * a virtual module so that `tsc` has something to typecheck against, and it is deliberately empty
 * so that a megabyte of base64 never lands in a commit — `clientAssets.test.ts` fails if it stops
 * being empty.
 *
 * ## Why the assets are inlined at all
 *
 * Until now the server read `index.html`, `client.js`, `client.css` and the guide diagrams from
 * `dist/client` beside itself. That is fine for an installed package and it is the one thing
 * standing between `dist/cli.js` and being a *single file you can copy to another machine* —
 * which is what `--export-pkg` is for, and what somebody needs when they can install Node but
 * cannot reach a registry.
 *
 * The server's own dependencies were already bundled for exactly that reason (see `esbuild.mjs`).
 * This finishes the job: with the assets in, the bundle needs nothing beside it at all.
 *
 * Base64 rather than raw text because the same map carries HTML, CSS, JavaScript and SVG, and one
 * encoding that never has to worry about quotes or line endings is worth more than the few percent
 * it costs.
 */
export const CLIENT_ASSET_BYTES: Record<string, string> = {}
