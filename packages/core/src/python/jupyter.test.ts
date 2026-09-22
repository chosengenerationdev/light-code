import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  JUPYTER_CONNECTION_ENV,
  checkConnectionFile,
  describeKernels,
  discoverKernels,
  runtimeDirs,
  type KernelCandidate,
} from './jupyter.js'

/**
 * Finding a kernel, and — more importantly — refusing to pick one.
 *
 * The question this was built to answer was "can Light Code auto-detect the kernel, or does the
 * notebook have to pass it?". The answer is that the notebook passes it, and these tests pin the
 * half that makes that answer honest: discovery *offers*, and says so when it cannot tell two
 * kernels apart.
 */

let scratch: string

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-jupyter-'))
})

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

/** A file with the shape a real connection file has. Ports and key are invented. */
async function writeConnectionFile(dir: string, id: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `kernel-${id}.json`)
  await fs.writeFile(
    file,
    JSON.stringify({
      shell_port: 51000,
      iopub_port: 51001,
      control_port: 51002,
      hb_port: 51003,
      stdin_port: 51004,
      ip: '127.0.0.1',
      key: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      transport: 'tcp',
      kernel_name: 'python3',
    }),
    'utf8',
  )
  return file
}

describe('discoverKernels', () => {
  it('finds connection files in the runtime dir it is pointed at', async () => {
    const runtime = path.join(scratch, 'runtime')
    await writeConnectionFile(runtime, 'aaa')
    const found = await discoverKernels({ JUPYTER_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv)
    expect(found.map((each) => each.id)).toEqual(['aaa'])
  })

  it('ignores anything that is not a kernel connection file', async () => {
    const runtime = path.join(scratch, 'runtime')
    await writeConnectionFile(runtime, 'aaa')
    // A Jupyter runtime dir holds server files, notebook secrets and lock files too.
    await fs.writeFile(path.join(runtime, 'jpserver-1234.json'), '{}', 'utf8')
    await fs.writeFile(path.join(runtime, 'notebook_cookie_secret'), 'x', 'utf8')
    const found = await discoverKernels({ JUPYTER_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv)
    expect(found.map((each) => each.id)).toEqual(['aaa'])
  })

  it('survives a runtime dir that does not exist', async () => {
    // Most of the list never exists on any given machine — that is why there is a list.
    const found = await discoverKernels({
      JUPYTER_RUNTIME_DIR: path.join(scratch, 'nope'),
    } as NodeJS.ProcessEnv)
    expect(found).toEqual([])
  })

  it('does not repeat a directory named twice', () => {
    const dirs = runtimeDirs({
      JUPYTER_RUNTIME_DIR: '/tmp/runtime',
      JUPYTER_DATA_DIR: '/tmp',
    } as NodeJS.ProcessEnv)
    expect(new Set(dirs).size).toBe(dirs.length)
  })
})

describe('describeKernels', () => {
  const candidate = (id: string): KernelCandidate => ({
    connectionFile: `/runtime/kernel-${id}.json`,
    id,
    startedAt: 0,
  })

  it('refuses to choose between two, and says why', () => {
    /*
     * The load-bearing test. Picking the newest would be right most of the time and silently
     * wrong the rest, and "silently wrong" here means running somebody's tool inside the wrong
     * notebook — the same refusal the Excel tools make about attaching to a session.
     */
    const said = describeKernels([candidate('aaa'), candidate('bbb')])
    expect(said).toContain('nothing outside a kernel can tell which one is yours')
    expect(said).toContain('get_connection_file')
    // Both offered, neither chosen.
    expect(said).toContain('kernel-aaa.json')
    expect(said).toContain('kernel-bbb.json')
  })

  it('calls a single kernel a candidate, not an answer', () => {
    // A connection file outlives a kernel that was killed, and one kernel now is not one kernel
    // in ten minutes.
    const said = describeKernels([candidate('aaa')])
    expect(said).toContain('not a confirmation')
  })

  it('tells somebody what to do when nothing is running', () => {
    expect(describeKernels([])).toContain('get_connection_file')
  })
})

describe('checkConnectionFile', () => {
  it('accepts a real one', async () => {
    const file = await writeConnectionFile(path.join(scratch, 'runtime'), 'aaa')
    const result = await checkConnectionFile(file)
    expect(result.ok).toBe(true)
  })

  it('rejects JSON that is not a connection file, naming what is missing', async () => {
    // Pointing at the wrong `.json` is an easy mistake, and the failure it causes otherwise
    // happens much later, inside jupyter_client, where it reads as the kernel being broken.
    const file = path.join(scratch, 'other.json')
    await fs.writeFile(file, JSON.stringify({ hello: 'world' }), 'utf8')
    const result = await checkConnectionFile(file)
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.problem : '').toContain('shell_port')
  })

  it('says a missing file may mean the kernel restarted', async () => {
    // Jupyter writes a new connection file on restart, so a stored path going stale is the
    // ordinary case rather than an odd one.
    const result = await checkConnectionFile(path.join(scratch, 'kernel-gone.json'))
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.problem : '').toContain('restarted')
  })
})

describe('the kernel path in the worker', () => {
  /*
   * Read from the worker source, because the two defects this pins are both *missing calls* -
   * invisible to any test of the thing that was not called, and found only by starting a real
   * kernel and asking it.
   */
  const worker = (): Promise<string> =>
    fs.readFile(path.join(import.meta.dirname, 'worker', 'main.py'), 'utf8')

  it('actually sends the preamble, rather than only defining it', async () => {
    /*
     * The first version defined `_kernel_preamble` and never called it. Every tool call then
     * reached a kernel that had never heard of `_lc_json` and failed with a NameError on line 1
     * of the cell - which reads as the *tool* being broken. Nothing in the config, the schema or
     * the wiring was wrong.
     */
    const source = await worker()
    expect(source).toContain('_kernel_run(client, _kernel_preamble()')
  })

  it('installs light_code inside the kernel, so a tool that imports it still works', async () => {
    // The worker registers that module in its own sys.modules, which the kernel has never heard
    // of. Without this, moving a tool into a kernel turns a working tool into an ImportError.
    const source = await worker()
    expect(source).toContain("_lc_sys.modules['light_code'] = _lc_helper")
  })

  it('gives the tool the notebook namespace, which is the whole point', async () => {
    const source = await worker()
    expect(source).toContain('_lc_mod.session = globals()')
  })

  it('reads the result from behind a marker, never from the output', async () => {
    // A kernel is full of libraries that print banners and warnings on the same channel as the
    // answer. CLAUDE.md section 14 records this going wrong in the identity wrappers.
    const source = await worker()
    expect(source).toContain('_KERNEL_MARKER')
  })
})

describe('the environment variable', () => {
  it('is one name, shared by the host and the worker', async () => {
    /*
     * Read from the worker source rather than asserted twice. The host sets this variable and
     * the Python worker reads it; a rename on one side is exactly the silent break this
     * repository keeps recording, and nothing else would fail.
     */
    const worker = await fs.readFile(
      path.join(import.meta.dirname, 'worker', 'main.py'),
      'utf8',
    )
    expect(worker).toContain(JUPYTER_CONNECTION_ENV)
  })
})
