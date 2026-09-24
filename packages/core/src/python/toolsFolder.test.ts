import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { Logger } from '../logging/logger.js'
import { PythonManager } from './manager.js'
import { defaultPythonToolsDir } from './registry.js'

/**
 * Where the Python tools folder is, and why asking the runtime for it was wrong.
 *
 * Reported: *"clicking upload all existing python tools, gives no local folder to copy from
 * error"*. The handler asked `python.toolDirectories()`, and `PythonManager.configure` sets its
 * `toolsDir` only **after** returning early when dynamic tools are off — so with the feature
 * switched off the list was empty and the answer was "there is nowhere".
 *
 * The deeper mistake was asking the wrong thing. Copying `.py` files in, or uploading them to a
 * bucket, does not need the Python runtime: the folder is a fact about *configuration*, and the
 * files are on disk whether or not a worker is running.
 */

const bridge = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'host', 'bridge.ts'),
  'utf8',
)

describe('defaultPythonToolsDir', () => {
  it('is inside the workspace, so changes land in git', () => {
    // §13's main real mitigation: model-authored code that gets code-reviewed.
    expect(defaultPythonToolsDir(path.join('D:', 'proj'))).toBe(
      path.join('D:', 'proj', '.lightcode', 'tools'),
    )
  })

  it('is the one owner of that default', () => {
    /*
     * The manager and the bridge both need it, and two copies of a path default is the drift this
     * repository keeps paying for. Read from the source, because the defect would be a *second*
     * computation - invisible to any test of the first.
     */
    const manager = fs.readFileSync(path.join(import.meta.dirname, 'manager.ts'), 'utf8')
    expect(manager).toContain('defaultPythonToolsDir(')
    expect(manager).not.toMatch(/path\.join\([^)]*'\.lightcode',\s*'tools'\)/)
    expect(bridge).not.toMatch(/path\.join\([^)]*'\.lightcode',\s*'tools'\)/)
  })
})

describe('the manager with the feature switched off', () => {
  it('reports no tool directories, which is what broke the upload button', async () => {
    /*
     * Not a hypothetical: this is the state the reporter was in. Pinned so the reason the bridge
     * stopped asking the manager stays visible - if this ever starts returning a folder, the
     * workaround in the bridge is still correct but its comment would be wrong.
     */
    const manager = new PythonManager({
      workspaceRoot: path.join('D:', 'proj'),
      storageDir: path.join('D:', 'storage'),
      logger: new Logger({ level: 'error', sink: () => {} }),
      secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    } as never)

    await manager.configure({ dynamicTools: 'off' })
    expect(manager.toolDirectories()).toEqual([])
  })
})

describe('the bridge resolves the folder from config', () => {
  it('does not ask the Python runtime where the files are', () => {
    // The whole fix. `managedFolderFor` reads config and falls back to the shared default.
    const at = bridge.indexOf('async function managedFolderFor')
    expect(at, 'managedFolderFor not found').toBeGreaterThan(-1)
    const body = bridge.slice(at, bridge.indexOf('\n  }', at))
    expect(body).toContain('configManager.load()')
    expect(body).toContain('defaultPythonToolsDir')
    expect(body).not.toContain('python.toolDirectories()')
  })

  it('uses it for both the copy-in and the upload-all paths', () => {
    for (const handler of ['handleMigrateFolder', 'handlePublishAllToBucket']) {
      const at = bridge.indexOf(`async function ${handler}`)
      expect(at, `${handler} not found`).toBeGreaterThan(-1)
      const body = bridge.slice(at, bridge.indexOf('\n  }', at))
      expect(body, handler).toContain('managedFolderFor(')
      // Asking the runtime is the bug; neither may do it again.
      expect(body, handler).not.toContain('python.toolDirectories()')
    }
  })

  it('says what to do when there genuinely is nowhere', () => {
    // "No local folder to copy from" told the user nothing they could act on.
    const at = bridge.indexOf('function noFolderMessage')
    expect(at).toBeGreaterThan(-1)
    const body = bridge.slice(at, bridge.indexOf('\n  }', at))
    expect(body).toContain('Open a folder first')
  })
})
