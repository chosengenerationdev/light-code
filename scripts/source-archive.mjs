import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

/**
 * The project's own source as a zip, built into the VSIX for the header's "Export source code".
 *
 * Asked for by somebody who cannot reach GitHub from the office and wants to keep building this
 * product there, with Claude: the archive must be a folder that opens in VS Code and builds as it
 * stands. So it is the **whole repository** — every app, CLAUDE.md, changesets, CI, scripts,
 * icons — not the Node half that `apps/host/sourcePack.mjs` carries for `--export-code`.
 *
 * ## Which files
 *
 * What git tracks, plus new files not yet committed (`--others --exclude-standard`), so the
 * archive is exactly the working tree minus everything `.gitignore` already rules out:
 * `node_modules`, `dist`, build output, packaged artefacts. Built on a copy that has no `.git` —
 * one exported to the office, say — it walks the tree with the same exclusions instead, so an
 * export of an export still works.
 *
 * Left out on purpose: the demo animations in `docs/gifs` (48 MB, documentation of the product
 * rather than part of building it) and any packaged `.vsix`/`.tgz`.
 *
 * ## Why a hand-written zip
 *
 * Zip because Windows opens it without anything installed — the person extracting it is on a
 * locked-down machine. Written here rather than with a library because a library is a dependency
 * the office build would then have to fetch, for forty lines of format.
 */

const EXCLUDED_PREFIXES = ['docs/gifs/']
const EXCLUDED_EXTENSIONS = new Set(['.vsix', '.tgz'])
const WALK_SKIP = new Set(['node_modules', 'dist', '.git', 'build', '.gradle', '.intellijPlatform', '.turbo', 'coverage', 'out'])

function included(relative) {
  if (EXCLUDED_PREFIXES.some((prefix) => relative.startsWith(prefix))) return false
  if (EXCLUDED_EXTENSIONS.has(path.extname(relative).toLowerCase())) return false
  if (/^apps\/host\/light-code-pkg-[^/]*$/.test(relative)) return false
  return !relative.split('/').some((part) => WALK_SKIP.has(part) || part.endsWith('.tsbuildinfo'))
}

/** Repo-relative paths with forward slashes, sorted so two builds of one tree produce one zip. */
export function projectFiles(repoRoot) {
  let listed
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
    listed = output.split('\0').filter((entry) => entry.length > 0)
  } catch {
    listed = []
    const walk = (relative) => {
      for (const entry of fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
        if (WALK_SKIP.has(entry.name)) continue
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`
        if (entry.isDirectory()) walk(child)
        else if (entry.isFile()) listed.push(child)
      }
    }
    walk('')
  }
  return [...new Set(listed)]
    .filter(included)
    // A file deleted but not yet committed is still in the index; there is nothing to pack.
    .filter((relative) => fs.existsSync(path.join(repoRoot, relative)))
    .sort()
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A fixed timestamp (2026-01-01), so rebuilding an unchanged tree gives a byte-identical zip. */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

/** `entries` is `[name, Buffer][]`. Deflated, UTF-8 names, no zip64 (a source tree is far below 4 GB). */
export function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    // Stored when compressing does not help, as zip tools do; a PNG does not shrink.
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made on Unix, so permissions below are honoured
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** The note at the top of the folder: what this is and how to build it with nothing but a registry. */
export function startHere(version) {
  return `# Light Code ${version} — source

This folder is the complete Light Code source, exported from the extension's own
"Export source code" button. It is a normal project: open it in VS Code and build.
It has no git history — see "Version control" below.

## Build it

**Extract to a short path first**, such as \`C:\\src\\light-code\`. Windows refuses to start a
program whose full path is longer than 260 characters, and a build tool deep inside
\`node_modules\` under a long folder name passes that easily — the error then says the
program was "not found" (ENOENT) while the file is plainly there.

You need **Node.js 18 or newer** and **pnpm** (\`npm install -g pnpm\`, or \`corepack enable\`).
Dependencies come from the npm registry, or from your organisation's npm mirror if
\`.npmrc\`/\`npm config\` points there.

\`\`\`
pnpm install --ignore-scripts
pnpm build
pnpm test
pnpm package        # writes apps/vscode/light-code-vscode-<version>.vsix
\`\`\`

\`--ignore-scripts\` is deliberate (see CLAUDE.md, invariant 4). It also means the
ripgrep binary is not downloaded; the extension then searches with its built-in search,
which works everywhere and is only slower on very large repositories.

Other packages, from the same tree:

- Node host: \`pnpm --filter @chosengeneration/light-code run build\`, then
  \`node apps/host/dist/cli.cjs\` (and \`--export-pkg\` for a single-file copy).
- IntelliJ / PyCharm plugin: \`apps/intellij\`, built with Gradle 8 and a JDK 17
  (\`gradle buildPlugin\`) **after** the Node host, which it packs inside itself so it has
  the same features and fixes; the zip lands in \`apps/intellij/build/distributions\`.

- Fire Code, the Windows app for several codebases at once: \`apps/sun\`. Needs
  Rust 1.86 or newer (\`rustup\`, MSVC toolchain). \`node apps/sun/scripts/build.mjs\` builds the
  Node host, the exe and the npm package, which lands in \`apps/sun\`; it packs the host too.

Every release builds all four from the same commit, so each package has the same
enhancements and fixes (CLAUDE.md §17).

## Working on it with Claude

Open this folder in VS Code and start Claude Code here. **CLAUDE.md** at the top is the
project's durable context — architecture, invariants, every decision and why — and Claude
reads it automatically. Read §3 (hard invariants) and §17 (conventions) yourself first.

## Version control

Start a repository so changes can be tracked and Claude's checkpoints work:

\`\`\`
git init
git add -A
git commit -m "Light Code ${version} source"
\`\`\`

Left out of this export: the demo animations in docs/gifs (48 MB, documentation only).
`
}

/** Builds the archive for `version` from the repository at `repoRoot`, written to `outFile`. */
export function writeSourceArchive(repoRoot, outFile, version) {
  const folder = `light-code-source-${version}`
  const files = projectFiles(repoRoot)
  const entries = [[`${folder}/START_HERE.md`, Buffer.from(startHere(version), 'utf8')]]
  for (const relative of files) {
    if (relative === 'START_HERE.md') continue
    entries.push([`${folder}/${relative}`, fs.readFileSync(path.join(repoRoot, relative))])
  }
  const archive = zip(entries)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, archive)
  return { files: entries.length, bytes: archive.length }
}

// `node scripts/source-archive.mjs <out.zip> <version>` for building one by hand.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const [outFile = 'light-code-source.zip', version = 'dev'] = process.argv.slice(2)
  const result = writeSourceArchive(repoRoot, path.resolve(outFile), version)
  console.log(`wrote ${outFile}: ${result.files} files, ${Math.round(result.bytes / 1024)} KB`)
}
