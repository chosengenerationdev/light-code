import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Finding the Jupyter kernel a session should run its Python tools in.
 *
 * ## The answer to "can we detect it, or must Python pass it?"
 *
 * **Python passes it, and that is not a shortcut.** A kernel knows its own connection file —
 * `ipykernel.get_connection_file()` returns it in one line, from inside the notebook. Nothing
 * outside the kernel knows which kernel is which. From another process the most that can be
 * done is to list `<runtime-dir>/kernel-*.json` and guess, and with more than one kernel
 * running — the ordinary case for anybody who uses Jupyter — a guess means running a tool
 * inside somebody's *other* notebook. Newest-by-mtime is right most of the time and silently
 * wrong the rest, which is the worst shape a default can have.
 *
 * That is the same refusal the Excel tools make about attaching (§12c): answering "the session
 * I have open" with a different one destroys trust in every later answer, so where there is
 * nothing to disambiguate with, ask rather than choose.
 *
 * ## So what is discovery for
 *
 * Offering, never choosing. `discoverKernels` lists what is running so a person can pick one,
 * and `describeKernels` says plainly when it cannot tell them apart. Exactly one candidate is
 * still only a candidate — it is reported as "this is the only one running", not as the answer
 * — because a single kernel now is not a single kernel in ten minutes.
 *
 * ## What the notebook does
 *
 * ```python
 * from ipykernel import get_connection_file
 * subprocess.run([...,"--jupyter-kernel", get_connection_file()])
 * ```
 *
 * or set `LIGHT_CODE_JUPYTER_CONNECTION_FILE`, which is what the host passes down to the
 * worker either way.
 */

/** The environment variable the Python worker reads. One name, used by every path. */
export const JUPYTER_CONNECTION_ENV = 'LIGHT_CODE_JUPYTER_CONNECTION_FILE'

export interface KernelCandidate {
  /** Absolute path to the connection file. */
  connectionFile: string
  /** The kernel id Jupyter uses, taken from the filename. */
  id: string
  /** When the file was written, which is roughly when the kernel started. */
  startedAt: number
}

/**
 * Where Jupyter keeps connection files for running kernels.
 *
 * `jupyter --runtime-dir` is authoritative, but shelling out to it means finding a `jupyter`
 * first — and if we could do that reliably we would not need any of this. These are the
 * documented defaults, and an unknown layout simply yields nothing, which is honest: the
 * caller's fallback is to ask, and asking is the recommended path anyway.
 */
export function runtimeDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = []
  const explicit = env['JUPYTER_RUNTIME_DIR']
  if (explicit !== undefined && explicit.length > 0) dirs.push(explicit)

  const dataHome = env['JUPYTER_DATA_DIR']
  if (dataHome !== undefined && dataHome.length > 0) dirs.push(path.join(dataHome, 'runtime'))

  const home = os.homedir()
  if (process.platform === 'win32') {
    const appData = env['APPDATA']
    if (appData !== undefined && appData.length > 0) dirs.push(path.join(appData, 'jupyter', 'runtime'))
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Jupyter', 'runtime'))
  }
  // The XDG location, which Linux uses and which a conda install can produce anywhere.
  const xdg = env['XDG_RUNTIME_DIR']
  if (xdg !== undefined && xdg.length > 0) dirs.push(path.join(xdg, 'jupyter'))
  dirs.push(path.join(home, '.local', 'share', 'jupyter', 'runtime'))

  return [...new Set(dirs)]
}

/**
 * Connection files for kernels that look like they are running, newest first.
 *
 * "Look like" is deliberate: a connection file outlives a kernel that was killed rather than
 * shut down, so this is a list of candidates and never a list of facts. Whether a kernel is
 * really there is settled by connecting to it, which is what the worker does.
 */
export async function discoverKernels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KernelCandidate[]> {
  const found: KernelCandidate[] = []
  for (const dir of runtimeDirs(env)) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      // A runtime dir that does not exist is the normal case for most of the list.
      continue
    }
    for (const entry of entries) {
      if (!/^kernel-.+\.json$/.test(entry)) continue
      const connectionFile = path.join(dir, entry)
      try {
        const stat = await fs.stat(connectionFile)
        found.push({
          connectionFile,
          id: entry.replace(/^kernel-/, '').replace(/\.json$/, ''),
          startedAt: stat.mtimeMs,
        })
      } catch {
        continue
      }
    }
  }
  return found.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * What to tell the user about the kernels found — including, and especially, when we cannot
 * tell which is theirs.
 *
 * Never returns a chosen kernel. The wording is the feature: "two kernels are running and
 * nothing here can tell which one is yours" is a useful sentence, and picking one would
 * replace it with an answer that is wrong half the time and says so never.
 */
export function describeKernels(candidates: readonly KernelCandidate[]): string {
  if (candidates.length === 0) {
    return (
      'No running Jupyter kernel was found. Pass the connection file explicitly — in the ' +
      'notebook, `from ipykernel import get_connection_file; get_connection_file()` gives it ' +
      'to you, and that is the reliable way in any case.'
    )
  }
  if (candidates.length === 1) {
    const only = candidates[0] as KernelCandidate
    return (
      `One kernel appears to be running: ${only.connectionFile}. That is the only candidate, ` +
      'not a confirmation — a connection file outlives a kernel that was killed, and a second ' +
      'notebook opened in a minute would make this ambiguous. The notebook telling Light Code ' +
      'its own connection file stays the reliable way.'
    )
  }
  return (
    `${String(candidates.length)} kernels appear to be running, and nothing outside a kernel ` +
    'can tell which one is yours — so none has been chosen. Have the notebook pass its own: ' +
    '`from ipykernel import get_connection_file; get_connection_file()`.\n' +
    candidates.map((candidate) => `  ${candidate.connectionFile}`).join('\n')
  )
}

/**
 * Checks a configured connection file before anything depends on it.
 *
 * Read at the point it is configured rather than at the first tool call, for `Test Connection`'s
 * reason (§10): a path that is wrong should say so while somebody is looking at the setting,
 * not halfway through a turn as a failure that reads as the tool being broken.
 */
export async function checkConnectionFile(
  connectionFile: string,
): Promise<{ ok: true; id: string } | { ok: false; problem: string }> {
  try {
    const raw = await fs.readFile(connectionFile, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // `key` and `shell_port` are what a connection file is *for*. Their absence means this is
    // some other JSON, which is worth saying rather than failing later inside jupyter_client.
    if (typeof parsed['shell_port'] !== 'number' || typeof parsed['key'] !== 'string') {
      return {
        ok: false,
        problem:
          `${connectionFile} is JSON but not a Jupyter connection file — it has no shell_port ` +
          'or key. In the notebook, `from ipykernel import get_connection_file; ' +
          'get_connection_file()` prints the right path.',
      }
    }
    return { ok: true, id: path.basename(connectionFile).replace(/^kernel-|\.json$/g, '') }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      problem:
        `Could not read the kernel connection file ${connectionFile}: ${reason}. If the kernel ` +
        'was restarted its connection file is replaced, so the path changes with it.',
    }
  }
}
