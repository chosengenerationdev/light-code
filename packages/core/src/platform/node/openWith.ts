import { spawn } from 'node:child_process'

/**
 * Opening a file with its usual program, and showing it in the file manager, from a host with no
 * editor of its own (the local Node host, Fire Code, JetBrains). VS Code uses its own `openExternal`.
 *
 * The path is passed as an argument, never through a shell, so nothing in a file name can become a
 * command (CLAUDE.md section 16). Never offered on a shared server: it would open on the server's desktop.
 */

function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore' })
    child.once('error', (error) => reject(new Error(`Could not start ${command}: ${error.message}`)))
    // explorer.exe exits 1 even when it opened the file, so its exit code says nothing.
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export function openWithDefaultApp(filePath: string): Promise<void> {
  if (process.platform === 'win32') return launch('explorer.exe', [filePath])
  if (process.platform === 'darwin') return launch('open', [filePath])
  return launch('xdg-open', [filePath])
}

export function revealInFolder(filePath: string): Promise<void> {
  // `/select,<path>` is one argument to explorer, and is how it is documented.
  if (process.platform === 'win32') return launch('explorer.exe', [`/select,${filePath}`])
  if (process.platform === 'darwin') return launch('open', ['-R', filePath])
  // No portable "select" on Linux file managers: open the folder.
  return launch('xdg-open', [filePath.slice(0, Math.max(1, filePath.lastIndexOf('/')))])
}
