import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * The package as npm installs it: packed, installed with plain npm into an empty folder, and started.
 * The tests run the bundle from this folder; this proves the published file list carries everything.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const pass = (text) => console.log(`PASS  ${text}`)
const fail = (text) => {
  console.error(`FAIL  ${text}`)
  process.exit(1)
}

const tgz = execFileSync(npm, ['pack', '--silent'], { cwd: here, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop()
const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-linux-smoke-'))
execFileSync(npm, ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', `./${tgz}`], {
  cwd: here,
  stdio: 'ignore',
  shell: process.platform === 'win32',
})
const modules = process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules')
const installed = path.join(modules, '@chosengeneration', 'light-code-addon-linux')

const files = fs.readdirSync(installed)
for (const required of ['package.json', 'linux.svg', 'dist', 'README.md', 'LICENSE']) if (!files.includes(required)) fail(`${required} is missing from the package`)
if (fs.existsSync(path.join(installed, 'node_modules'))) fail('it brought dependencies with it')
pass(`installed with nothing else: ${files.sort().join(', ')}`)

const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'))
if (manifest.lightCode?.addon?.settings?.title !== 'Linux') fail('no Linux tab declared')
pass('declares its Linux tab and icon')

const client = new Client({ name: 'smoke', version: '1' })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(installed, manifest.lightCode.addon.main)],
    env: { ...process.env, LIGHT_CODE_ADDON_DATA: prefix },
    stderr: 'ignore',
  }),
)
const { tools } = await client.listTools()
const names = tools.map((tool) => tool.name).sort().join(', ')
if (names !== 'download, forget_host_key, machines, run, test_connection') fail(`unexpected tools: ${names}`)
pass(`starts and offers: ${names}`)
await client.close()
fs.rmSync(prefix, { recursive: true, force: true })
console.log(`\nAdd-on smoke test passed: ${tgz}`)
