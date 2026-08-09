import { execFileSync } from 'node:child_process'

/**
 * Extracts a `.tgz` or `.vsix`/`.zip` archive.
 *
 * Exists because `tar` is not one program. On Windows, `C:\Windows\System32\tar.exe` is
 * bsdtar and reads both formats — but a Git Bash install puts GNU tar earlier on PATH,
 * and that one cannot read zip and chokes on `C:\`-style paths. Picking the system binary
 * explicitly there avoids depending on which one happens to win.
 */
export function extractArchive(archivePath, destination) {
  const gzip = archivePath.endsWith('.tgz') || archivePath.endsWith('.tar.gz')

  const candidates =
    process.platform === 'win32'
      ? [
          ['C:\\Windows\\System32\\tar.exe', [gzip ? '-xzf' : '-xf', archivePath, '-C', destination]],
          ['tar', [gzip ? '-xzf' : '-xf', archivePath, '-C', destination]],
        ]
      : [
          ['tar', [gzip ? '-xzf' : '-xf', archivePath, '-C', destination]],
          ...(gzip ? [] : [['unzip', ['-q', archivePath, '-d', destination]]]),
        ]

  let lastError
  for (const [command, args] of candidates) {
    try {
      execFileSync(command, args, { stdio: 'ignore' })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Could not extract ${archivePath}: ${lastError?.message ?? 'no usable extractor found'}`)
}
