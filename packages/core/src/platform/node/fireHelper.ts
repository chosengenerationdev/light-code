import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Fire Code's Rust helper (`fire-fs.exe`), found on this machine so a host that does not ship it - the
 * VS Code extension, a plain Node host - can still offer the Rust tools.
 *
 * Asked for directly: "if fire-code is installed, light code uses the tools of fire-code by default, in
 * this way we avoid big packages". npm's global folder differs between machines, so the one place that
 * knows where the helper is says so: Fire Code writes `helper.json` in its data folder on every start.
 * The npm default location is tried after it, for an install that has not been started yet.
 *
 * Nothing a workspace controls is read here: the data folder is per user, and the paths are fixed.
 */
export function findFireCodeHelper(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined
  const candidates: string[] = []
  const dataDirs = [env['FIRE_CODE_HOME'], env['LOCALAPPDATA'] !== undefined ? path.join(env['LOCALAPPDATA'], 'fire-code') : undefined]
  for (const dir of dataDirs) {
    if (dir === undefined) continue
    try {
      const record = JSON.parse(readFileSync(path.join(dir, 'helper.json'), 'utf8')) as { fireFs?: unknown }
      if (typeof record.fireFs === 'string') candidates.push(record.fireFs)
    } catch {
      // No record: Fire Code was never started here, or under another data folder.
    }
  }
  if (env['APPDATA'] !== undefined) {
    candidates.push(path.join(env['APPDATA'], 'npm', 'node_modules', '@chosengeneration', 'fire-code', 'dist', 'fire-fs.exe'))
  }
  return candidates.find((candidate) => path.isAbsolute(candidate) && candidate.toLowerCase().endsWith('fire-fs.exe') && existsSync(candidate))
}

/** The operations a helper answers. Helpers before `capabilities` existed had exactly these. */
export const LEGACY_FAST_FS_OPS: ReadonlySet<string> = new Set(['find', 'summary', 'duplicates', 'readMany', 'inspect', 'lines', 'tail', 'grep', 'table', 'transfer', 'archive', 'names'])

/** Asks the helper what it can do. A helper too old to say gets the legacy set; one that will not run gets nothing. */
export function fastFsCapabilities(exe: string, timeoutMs = 5000): Promise<{ version?: string; ops: ReadonlySet<string> } | undefined> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (value: { version?: string; ops: ReadonlySet<string> } | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      done(undefined)
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    child.on('error', () => done(undefined))
    child.on('close', () => {
      try {
        const answer = JSON.parse(out) as { ok?: boolean; ops?: unknown; version?: unknown; error?: unknown }
        if (answer.ok === true && Array.isArray(answer.ops)) {
          done({ ops: new Set(answer.ops.filter((op): op is string => typeof op === 'string')), ...(typeof answer.version === 'string' ? { version: answer.version } : {}) })
        } else {
          done({ ops: LEGACY_FAST_FS_OPS })
        }
      } catch {
        done(undefined)
      }
    })
    child.stdin.end(JSON.stringify({ op: 'capabilities' }))
  })
}
