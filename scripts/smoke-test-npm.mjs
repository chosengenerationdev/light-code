#!/usr/bin/env node
/**
 * Packs the CLI, installs the tarball into an empty directory, and runs it.
 *
 * This is the npm counterpart of `smoke-test-vsix.mjs`, and it exists for the same reason:
 * `pnpm build`, `pnpm typecheck` and `pnpm test` all passed on a VSIX that could not
 * activate at all, because nothing in the pipeline had ever looked at the artifact. A
 * workspace has every dependency hoisted and every sibling package linked, so a bundled
 * import or a missing `dependencies` entry is invisible until someone installs it fresh.
 *
 * Deliberately uses `npm install` on the tarball rather than pnpm: that is what a user
 * running `npx` gets, and pnpm's isolated layout would mask a missing dependency
 * differently.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOST_DIR = path.resolve('apps/host')
const results = []
let failed = false

function check(label, fn) {
  try {
    const detail = fn()
    results.push(`PASS  ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  } catch (error) {
    failed = true
    results.push(`FAIL  ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(HOST_DIR, 'package.json'), 'utf8'))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-npm-'))

try {
  // `npm pack` honours `files`, so this is byte-for-byte what the registry would serve.
  const packed = execFileSync('npm', ['pack', '--pack-destination', scratch, '--silent'], {
    cwd: HOST_DIR,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
    .trim()
    .split('\n')
    .pop()
  const tarball = path.join(scratch, path.basename(packed))

  check('the tarball packs', () => `${(fs.statSync(tarball).size / 1024).toFixed(0)} KB`)

  check('it is not marked private', () => {
    if (manifest.private === true) throw new Error('`private: true` blocks publishing')
  })

  check('no workspace: dependency survives into the manifest', () => {
    const bad = Object.entries(manifest.dependencies ?? {}).filter(([, range]) =>
      String(range).startsWith('workspace:'),
    )
    if (bad.length > 0) {
      throw new Error(`${bad.map(([name]) => name).join(', ')} — unpublished, so a fresh install would fail`)
    }
  })

  const project = path.join(scratch, 'consumer')
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true }))

  check('it installs from the tarball into an empty project', () => {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error', tarball], {
      cwd: project,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: 'pipe',
    })
  })

  const installed = path.join(project, 'node_modules', manifest.name)

  check('every asset the client needs is in the package', () => {
    const missing = ['dist/cli.js', 'dist/client/client.js', 'dist/client/index.html', 'dist/client/client.css'].filter(
      (asset) => !fs.existsSync(path.join(installed, asset)),
    )
    if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`)
  })

  check('the entry point keeps its shebang', () => {
    const first = fs.readFileSync(path.join(installed, 'dist/cli.js'), 'utf8').split('\n')[0]
    if (!first.startsWith('#!')) throw new Error(`first line is ${JSON.stringify(first)}`)
  })

  check('the bin shim is linked', () => {
    const shim = path.join(project, 'node_modules', '.bin', 'light-code')
    if (!fs.existsSync(shim) && !fs.existsSync(`${shim}.cmd`)) throw new Error('no light-code in node_modules/.bin')
  })

  /*
   * The check that would have caught the dead VSIX: actually execute it. --help exercises
   * module resolution for the whole bundle without binding a port or writing anything.
   */
  check('it runs — every external resolves at runtime', () => {
    const output = execFileSync(process.execPath, [path.join(installed, 'dist/cli.js'), '--help'], {
      cwd: project,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: 'pipe',
    })
    if (!output.includes('--workspace')) throw new Error('help output did not look right')
  })

  check('it starts, serves the page, and refuses an unauthenticated API call', () => {
    const dataDir = path.join(scratch, 'data')
    const port = 53987
    const child = execFileSync(
      process.execPath,
      ['-e', startAndProbe(path.join(installed, 'dist/cli.js'), port, dataDir)],
      { cwd: project, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' },
    )
    const report = JSON.parse(child.trim().split('\n').pop())
    if (report.page !== 200) throw new Error(`page returned ${report.page}`)
    if (report.unauthenticated !== 401) throw new Error(`unauthenticated API returned ${report.unauthenticated}`)
    if (report.foreignHost !== 421) throw new Error(`foreign Host returned ${report.foreignHost}`)
  })
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

process.stdout.write(`${results.join('\n')}\n`)
process.stdout.write(
  failed
    ? '\nnpm smoke test FAILED — do not publish.\n'
    : `\nnpm smoke test passed: ${manifest.name}@${manifest.version}\n`,
)
process.exit(failed ? 1 : 0)

/** Runs in a child so a hung server cannot wedge this script. */
function startAndProbe(cliPath, port, dataDir) {
  return `
    const { spawn } = require('node:child_process')
    const http = require('node:http')
    const child = spawn(process.execPath, [${JSON.stringify(cliPath)}, '--no-open', '--port', '${port}', '--data-dir', ${JSON.stringify(dataDir)}], { stdio: 'ignore' })
    const base = 'http://127.0.0.1:${port}'
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    /*
     * A raw http request, not fetch. \`Host\` is a forbidden header name in fetch, so undici
     * silently drops it — the rebinding probe would send the real Host and pass no matter
     * what the server did. This exact trap made the check report a false failure first, and
     * would just as happily have reported a false pass.
     */
    const rawGet = (headers) => new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: ${port}, path: '/', headers }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', reject)
      request.end()
    })

    ;(async () => {
      let page = 0
      for (let attempt = 0; attempt < 30; attempt++) {
        await wait(300)
        try { page = await rawGet({ Host: '127.0.0.1:${port}', 'Sec-Fetch-Site': 'none' }); break } catch {}
      }
      const unauthenticated = (await fetch(base + '/api/events', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status
      const foreignHost = await rawGet({ Host: 'evil.example' })
      child.kill()
      console.log(JSON.stringify({ page, unauthenticated, foreignHost }))
    })().catch((e) => { child.kill(); console.error(e); process.exit(1) })
  `
}
