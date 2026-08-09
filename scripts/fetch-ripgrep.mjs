#!/usr/bin/env node
/**
 * Downloads the ripgrep binary for each VSIX target into `.ripgrep-cache/<target>/`.
 *
 * Needed because ripgrep ships one npm package per platform and a package manager only
 * installs the one matching the current machine — so building a `win32-arm64` VSIX from an
 * x64 Linux runner has nothing to copy. `esbuild.mjs` looks in this cache first.
 *
 * In CI each matrix job builds one target, so this fetches one package. Run without
 * arguments locally to fetch them all.
 *
 *   node scripts/fetch-ripgrep.mjs                 # every target
 *   node scripts/fetch-ripgrep.mjs win32-x64       # just one
 *
 * This is the only script in the repo that reaches the network on purpose. It is a build
 * step, not something the extension does — invariant 4 is about the shipped product.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractArchive } from './extract.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Must match the matrix in `.github/workflows/release.yml`. */
export const TARGETS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']

/** Pinned to the version `@vscode/ripgrep` declares, so the binary matches the wrapper. */
function ripgrepVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'vscode', 'package.json'), 'utf8'))
  const declared = manifest.dependencies?.['@vscode/ripgrep'] ?? ''
  const version = declared.replace(/^[^0-9]*/, '')
  if (version.length === 0) throw new Error('Could not determine the @vscode/ripgrep version from apps/vscode/package.json')
  return version
}

function fetchTarget(target, version) {
  const executable = target.startsWith('win32') ? 'rg.exe' : 'rg'
  const destinationDir = path.join(repoRoot, '.ripgrep-cache', target)
  const destination = path.join(destinationDir, executable)

  if (fs.existsSync(destination)) {
    console.log(`${target}: already cached`)
    return
  }

  const packageName = `@vscode/ripgrep-${target}@${version}`
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `rg-${target}-`))
  try {
    console.log(`${target}: fetching ${packageName}`)
    // `npm pack` rather than install: no lockfile churn, no postinstall scripts.
    const tarball = execFileSync('npm', ['pack', packageName, '--silent', '--pack-destination', staging], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
      .trim()
      .split('\n')
      .pop()

    extractArchive(path.join(staging, tarball), staging)

    const extracted = path.join(staging, 'package', 'bin', executable)
    if (!fs.existsSync(extracted)) throw new Error(`${packageName} did not contain bin/${executable}`)

    fs.mkdirSync(destinationDir, { recursive: true })
    fs.copyFileSync(extracted, destination)
    if (!target.startsWith('win32')) fs.chmodSync(destination, 0o755)
    console.log(`${target}: cached ${(fs.statSync(destination).size / 1024 / 1024).toFixed(1)}MB`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

const requested = process.argv.slice(2)
const targets = requested.length > 0 ? requested : TARGETS
for (const target of targets) {
  if (!TARGETS.includes(target)) throw new Error(`Unknown target "${target}". Known: ${TARGETS.join(', ')}`)
}

const version = ripgrepVersion()
console.log(`ripgrep ${version}\n`)
for (const target of targets) fetchTarget(target, version)
console.log('\nDone. `.ripgrep-cache/` is gitignored; esbuild.mjs reads it via --target=<platform>.')
