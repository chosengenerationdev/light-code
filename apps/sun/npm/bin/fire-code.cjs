#!/usr/bin/env node
'use strict'
/*
 * `fire-code` - opens the Fire Code window and gives the terminal back.
 *
 * The window is a prebuilt exe in this package; there is nothing to compile and nothing was
 * downloaded at install (the package has no install scripts and no dependencies). This launcher
 * only tells it which Node to run each codebase's agent with - the one npm installed it with - and
 * where the bundled Light Code host is.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${version}\n`)
  process.exit(0)
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`fire-code ${version}

Opens Fire Code: every codebase in one window, each with its own Light Code agent.
If it is already open, brings that window forward.

  --version, -v   Print the version
  --help, -h      This text

Data lives in %LOCALAPPDATA%\\fire-code (set FIRE_CODE_HOME to move it).
`)
  process.exit(0)
}
if (process.platform !== 'win32') {
  process.stderr.write('Fire Code is a Windows application. On this system, use the Light Code Node host: npx @chosengeneration/light-code\n')
  process.exit(1)
}

const dist = path.join(root, 'dist')
const exe = path.join(dist, 'fire-code.exe')
if (!fs.existsSync(exe)) {
  process.stderr.write(`fire-code: ${exe} is missing. Reinstall with: npm i -g @chosengeneration/fire-code\n`)
  process.exit(1)
}

const child = spawn(exe, [], {
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    FIRE_CODE_NODE: process.execPath,
    FIRE_CODE_HOST: path.join(dist, 'host', 'light-code.cjs'),
  },
})
child.on('error', (error) => {
  process.stderr.write(`fire-code: could not start ${exe}: ${error.message}\n`)
  process.exit(1)
})
child.unref()
