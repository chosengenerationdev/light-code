// Installs the packed Sun Code tarball the way a user would and proves it works.
//
//   node apps/sun/scripts/smoke.mjs
//
// What it checks, and why each matters:
// - The manifest has no install scripts and no dependencies. That is the promise that makes the
//   install work on an office machine; one added later would break it with nothing else failing.
// - `npm i -g` into an empty prefix gives a working `sun-code` command (a workspace hoists
//   and links everything, so only a real install can show a missing file).
// - The installed exe starts a codebase's agent from the bundled host, and killing the window
//   kills that agent too - the job object is what keeps closed windows from leaving processes.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sun = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(sun, 'npm', 'package.json'), 'utf8'))
const tarball = path.join(sun, `chosengeneration-sun-code-${manifest.version}.tgz`)
const fail = (message) => {
  console.error(`✘ ${message}`)
  process.exit(1)
}
const ok = (message) => console.log(`✔ ${message}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!fs.existsSync(tarball)) fail(`${tarball} is missing - run node apps/sun/scripts/build.mjs first.`)

for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
  if (manifest.scripts?.[hook] !== undefined) fail(`the package has an install-time script (${hook}); installs must only copy files`)
}
for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
  if (manifest[kind] !== undefined && Object.keys(manifest[kind]).length > 0) fail(`the package declares ${kind}; it must have none`)
}
ok('no install scripts, no dependencies')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sun-smoke-'))
const prefix = path.join(work, 'prefix')
execFileSync('npm', ['install', '-g', '--prefix', JSON.stringify(prefix), '--no-audit', '--no-fund', JSON.stringify(tarball)], { stdio: 'inherit', shell: true })
const installed = path.join(prefix, 'node_modules', '@chosengeneration', 'sun-code')
for (const file of ['bin/sun-code.cjs', 'dist/sun-code.exe', 'dist/sun-fs.exe', 'dist/host/light-code.cjs', 'dist/rg.exe', 'dist/source.zip', 'README.md', 'LICENSE']) {
  if (!fs.existsSync(path.join(installed, file))) fail(`installed package lacks ${file}`)
}
ok('installed with plain npm; every file present')

const printed = execFileSync(JSON.stringify(path.join(prefix, 'sun-code.cmd')), ['--version'], { encoding: 'utf8', shell: true }).trim()
if (printed !== manifest.version) fail(`sun-code --version printed "${printed}", expected ${manifest.version}`)
ok(`sun-code --version → ${printed}`)

// A home of its own with one codebase, opened at launch.
const home = path.join(work, 'home')
const repo = path.join(work, 'repo')
fs.mkdirSync(repo, { recursive: true })
fs.writeFileSync(path.join(repo, 'README.md'), '# smoke\n')
fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(
  path.join(home, 'state.json'),
  JSON.stringify({
    projects: [{ id: 'psmoke', name: 'smoke', path: repo, configMode: 'new', configFile: path.join(home, 'projects', 'psmoke', 'config.json'), keepAwake: false, lastUsed: 1 }],
    settings: { lastProject: 'psmoke', startRecent: false, notifications: false },
  }),
)
const exe = spawn(path.join(installed, 'dist', 'sun-code.exe'), [], {
  env: {
    ...process.env,
    SUN_CODE_HOME: home,
    SUN_CODE_NODE: process.execPath,
    SUN_CODE_HOST: path.join(installed, 'dist', 'host', 'light-code.cjs'),
  },
  stdio: 'ignore',
})
const log = path.join(home, 'projects', 'psmoke', 'host.log')
let started = false
for (let waited = 0; waited < 60_000 && !started; waited += 500) {
  await sleep(500)
  started = fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('listening')
}
if (!started) {
  exe.kill()
  fail(`the codebase's agent did not start within 60s${fs.existsSync(log) ? `:\n${fs.readFileSync(log, 'utf8')}` : ' (no log)'}`)
}
ok('the window started the codebase agent from the bundled host')

const agents = () =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.includes(home))
if (agents().length === 0) fail('no agent process found for the smoke home')
execFileSync('taskkill', ['/PID', String(exe.pid), '/F'], { stdio: 'ignore' })
await sleep(1500)
if (agents().length > 0) fail('the agent outlived the window - the job object did not take it down')
ok('closing the window ended its agents')

fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 })
console.log('\nSun Code smoke test passed.')
