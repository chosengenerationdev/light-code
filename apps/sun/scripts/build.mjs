// Builds Sun Light Code and its npm package.
//
//   node apps/sun/scripts/build.mjs              # host, exe, package, tarball
//   node apps/sun/scripts/build.mjs --skip-host  # reuse apps/host/dist/cli.cjs as it is
//
// The package carries everything prebuilt - the exe, the Light Code host built from this same
// commit (CLAUDE.md §17), rg.exe and the source archive - and has no install scripts and no
// dependencies, so `npm i -g` only copies files. That is the point: installs that compile or
// download (Electron's) fail on locked-down office networks.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeSourceArchive } from '../../../scripts/source-archive.mjs'

const sun = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(sun, '../..')
const native = path.join(sun, 'native')
const stage = path.join(sun, 'package')
const args = process.argv.slice(2)
const quote = (a) => (/\s/.test(a) ? JSON.stringify(a) : a)
// pnpm, cargo and npm are .cmd shims on Windows, which need a shell; the shell then splits on spaces.
const run = (command, commandArgs, cwd) =>
  execFileSync(command, commandArgs.map(quote), { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

// One version, stated twice, checked here: the exe reports Cargo's, npm installs the manifest's.
const manifest = JSON.parse(fs.readFileSync(path.join(sun, 'npm', 'package.json'), 'utf8'))
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(native, 'Cargo.toml'), 'utf8'))?.[1]
if (cargoVersion !== manifest.version) {
  throw new Error(`Version mismatch: npm/package.json says ${manifest.version}, native/Cargo.toml says ${cargoVersion}. Set both.`)
}
const version = manifest.version
if (Number(version.split('.')[1]) === 66 || Number(version.split('.')[2]) === 66) {
  // A standing preference (CLAUDE.md §17): no version lands on 66.
  throw new Error(`Version ${version} contains 66; go one further.`)
}

if (!args.includes('--skip-host')) {
  console.log('▸ building the Light Code host (core, ui, host)')
  run('pnpm', ['-r', '--filter', '@chosengeneration/light-code...', 'run', 'build'], repo)
}
const host = path.join(repo, 'apps', 'host', 'dist', 'cli.cjs')
if (!fs.existsSync(host)) throw new Error(`${host} is missing. Build the host first, or drop --skip-host.`)

console.log('▸ building sun-light-code.exe (release)')
run('cargo', ['build', '--release'], native)
const exe = path.join(native, 'target', 'release', 'sun-light-code.exe')

const ripgrep = [
  path.join(repo, '.ripgrep-cache', 'win32-x64', 'rg.exe'),
  ...fs
    .readdirSync(path.join(repo, 'node_modules', '.pnpm'), { withFileTypes: true })
    .filter((d) => d.name.startsWith('@vscode+ripgrep-win32-x64'))
    .map((d) => path.join(repo, 'node_modules', '.pnpm', d.name, 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe')),
].find((p) => fs.existsSync(p))
if (ripgrep === undefined) {
  throw new Error('No win32-x64 rg.exe found. Run `node scripts/fetch-ripgrep.mjs win32-x64` once (a build step, not an install step).')
}

console.log('▸ staging the package')
// Emptied rather than deleted: it is where `npm publish` is run, and Windows refuses to remove a
// folder that is a terminal's current directory.
fs.mkdirSync(stage, { recursive: true })
for (const entry of fs.readdirSync(stage)) fs.rmSync(path.join(stage, entry), { recursive: true, force: true })
fs.mkdirSync(path.join(stage, 'dist', 'host'), { recursive: true })
fs.cpSync(path.join(sun, 'npm'), stage, { recursive: true })
fs.copyFileSync(path.join(sun, 'README.md'), path.join(stage, 'README.md'))
fs.copyFileSync(exe, path.join(stage, 'dist', 'sun-light-code.exe'))
// The parallel file helper behind find_files, read_many_files, big_file and query_table.
fs.copyFileSync(path.join(native, 'target', 'release', 'sun-fs.exe'), path.join(stage, 'dist', 'sun-fs.exe'))
fs.copyFileSync(host, path.join(stage, 'dist', 'host', 'light-code.cjs'))
fs.copyFileSync(ripgrep, path.join(stage, 'dist', 'rg.exe'))
const archive = writeSourceArchive(repo, path.join(stage, 'dist', 'source.zip'), `sun-${version}`)
console.log(`  source.zip: ${archive.files} files, ${Math.round(archive.bytes / 1024)} KB`)

for (const old of fs.readdirSync(sun).filter((f) => /^chosengeneration-sun-light-code-.*\.tgz$/.test(f))) {
  fs.rmSync(path.join(sun, old))
}
run('npm', ['pack', '--pack-destination', sun], stage)
const tarball = path.join(sun, `chosengeneration-sun-light-code-${version}.tgz`)
console.log(`\n✔ ${path.relative(repo, tarball)} (${(fs.statSync(tarball).size / 1024 ** 2).toFixed(1)} MB)`)
console.log('  Try it: npm i -g ' + tarball)
