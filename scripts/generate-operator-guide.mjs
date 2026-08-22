#!/usr/bin/env node
/**
 * Bakes `docs/hosting.md` into a TypeScript module so `light-code --guide` can print it.
 *
 * Inlined rather than read from disk at runtime, for the reason the Python worker is inlined:
 * esbuild does not copy `.md`, and resolving a path relative to the bundle is exactly what once
 * shipped a VSIX that could not activate. A published tarball has no `docs/` directory at all, so
 * a runtime read would work in every local check and fail for every real install.
 *
 * `operatorGuide.test.ts` fails if the generated copy drifts from the source, so the markdown
 * stays the one place it is edited.
 *
 *   node scripts/generate-operator-guide.mjs
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'docs', 'hosting.md')
const target = path.join(root, 'apps', 'host', 'src', 'generated', 'operatorGuide.ts')

const markdown = readFileSync(source, 'utf8')

const contents = `// GENERATED FILE — do not edit.
// Produced by scripts/generate-operator-guide.mjs from docs/hosting.md.
// Edit the markdown; run \`pnpm build\` or the script directly to regenerate.

/** The operator guide, as \`light-code --guide\` prints it. */
export const OPERATOR_GUIDE = ${JSON.stringify(markdown)}
`

mkdirSync(path.dirname(target), { recursive: true })
writeFileSync(target, contents, 'utf8')
process.stdout.write(`operator guide: ${String(markdown.length)} chars baked into apps/host/src/generated/operatorGuide.ts\n`)
