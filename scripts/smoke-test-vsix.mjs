#!/usr/bin/env node
/**
 * Loads a packaged VSIX's `extension.js` the way the extension host would, and calls
 * `activate`.
 *
 * This exists because of a real bug. `@vscode/ripgrep` was imported from core, which put a
 * top-level `require` for it into the bundle — but the package is not inside the VSIX under
 * `--no-dependencies`. Every published install would have failed to activate with
 * `MODULE_NOT_FOUND`, and **`pnpm build`, `pnpm typecheck`, `pnpm test` and `vsce package`
 * all passed**. Nothing in the pipeline looked at the artifact.
 *
 * The `vscode` module is stubbed, so this proves the bundle *loads and activates* — not
 * that the UI works. That is what MANUAL_VERIFICATION.md is for.
 *
 *   node scripts/smoke-test-vsix.mjs apps/vscode/light-code-vscode-win32-x64-0.1.0.vsix
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractArchive } from './extract.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function findVsix() {
  const fromArg = process.argv[2]
  if (fromArg !== undefined) return path.resolve(fromArg)

  const dir = path.join(repoRoot, 'apps', 'vscode')
  const candidates = fs.readdirSync(dir).filter((name) => name.endsWith('.vsix'))
  if (candidates.length === 0) throw new Error('No .vsix found. Run `pnpm package` first.')
  if (candidates.length > 1) throw new Error(`Several .vsix files found; name one explicitly:\n  ${candidates.join('\n  ')}`)
  return path.join(dir, candidates[0])
}

const vsixPath = findVsix()
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-smoke-'))
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  extractArchive(vsixPath, staging)
  const extensionRoot = path.join(staging, 'extension')

  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'))
  const mainPath = path.join(extensionRoot, manifest.main)

  check('manifest declares a main entry point', typeof manifest.main === 'string')
  check('the entry point is in the package', fs.existsSync(mainPath), manifest.main)

  // Every file the manifest points at must actually be present. A missing icon is a
  // marketplace rejection; a missing view icon is a broken Activity Bar.
  const referenced = [manifest.icon, ...(manifest.contributes?.viewsContainers?.activitybar ?? []).map((v) => v.icon)].filter(
    (value) => typeof value === 'string',
  )
  for (const relative of referenced) {
    check(`referenced asset exists: ${relative}`, fs.existsSync(path.join(extensionRoot, relative)))
  }

  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg'
  check(
    'ripgrep binary is bundled',
    fs.existsSync(path.join(extensionRoot, 'dist', 'bin', executable)),
    'without it, search degrades — and it used to break activation entirely',
  )

  // Stub `vscode` before loading. The extension host injects it; Node does not have it.
  const noop = () => undefined
  const disposable = { dispose: noop }
  const stub = {
    window: {
      registerWebviewViewProvider: () => disposable,
      createOutputChannel: () => ({ appendLine: noop, dispose: noop, show: noop }),
      showInformationMessage: noop,
      showWarningMessage: noop,
      showErrorMessage: noop,
    },
    commands: { registerCommand: () => disposable, executeCommand: noop },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: noop }),
      onDidChangeConfiguration: () => disposable,
      findFiles: async () => [],
    },
    Uri: { file: (p) => ({ fsPath: p, toString: () => p }), joinPath: (base) => base },
    EventEmitter: class {
      constructor() {
        this.event = () => disposable
      }
      fire() {}
      dispose() {}
    },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  }

  const Module = (await import('node:module')).default
  const originalResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode'
    return originalResolve.call(this, request, ...rest)
  }
  Module._cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: stub }

  const require = Module.createRequire(path.join(extensionRoot, 'noop.js'))

  let extension
  try {
    extension = require(mainPath)
    check('the bundle loads without throwing', true)
  } catch (error) {
    check('the bundle loads without throwing', false, String(error?.message ?? error))
    throw error
  }

  check('it exports activate()', typeof extension.activate === 'function')

  const storagePath = path.join(staging, 'storage')
  fs.mkdirSync(storagePath, { recursive: true })
  const context = {
    subscriptions: [],
    extensionPath: extensionRoot,
    extensionUri: { fsPath: extensionRoot },
    globalStorageUri: { fsPath: storagePath },
    workspaceState: { get: noop, update: async () => undefined },
    globalState: { get: noop, update: async () => undefined },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => disposable },
    extensionMode: 1,
  }

  try {
    await extension.activate(context)
    check('activate() completes', true)
    check('activation registered at least one disposable', context.subscriptions.length > 0, `${context.subscriptions.length}`)
  } catch (error) {
    check('activate() completes', false, String(error?.message ?? error))
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'VSIX smoke test passed' : `${failures} check(s) failed`}: ${path.basename(vsixPath)}`)
process.exit(failures === 0 ? 0 : 1)
