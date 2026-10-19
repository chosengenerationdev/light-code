import fs from 'node:fs'
import path from 'node:path'

/**
 * What the user entered on the Linux tab, as Light Code delivers it (core's `addons/delivery.ts`):
 * a settings file named by `LIGHT_CODE_ADDON_SETTINGS`, read on every call so a renamed machine needs
 * no restart, and each stored secret in an environment variable the file names.
 */

export interface Machine {
  id: string
  label: string
  host: string
  port: number
  username: string
  auth: 'pageant' | 'agent' | 'key' | 'password'
  keyFile?: string
  jumpVia?: string
  notes?: string
  password?: string
  passphrase?: string
}

export interface LinuxSettings {
  machines: Machine[]
  extraCommands: string[]
  timeoutSeconds: number
  maxDownloadMB: number
  dataDir: string
  downloadsDir: string
}

interface Delivered {
  values?: Record<string, unknown>
  records?: { id: string; values: Record<string, unknown> }[]
  secrets?: Record<string, Record<string, string>>
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): LinuxSettings {
  const file = env['LIGHT_CODE_ADDON_SETTINGS']
  const dataDir = env['LIGHT_CODE_ADDON_DATA'] ?? path.join(process.cwd(), '.light-code-addon-linux')
  let delivered: Delivered = {}
  if (file !== undefined) {
    try {
      delivered = JSON.parse(fs.readFileSync(file, 'utf8')) as Delivered
    } catch {
      delivered = {}
    }
  }
  const secret = (recordId: string, field: string): string | undefined => {
    const name = delivered.secrets?.[recordId]?.[field]
    const value = name === undefined ? undefined : env[name]
    return value === undefined || value.length === 0 ? undefined : value
  }
  const values = delivered.values ?? {}
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
  const machines: Machine[] = (delivered.records ?? []).flatMap((record) => {
    const v = record.values
    const label = text(v['label'])
    const host = text(v['host'])
    const username = text(v['username'])
    if (label === undefined || host === undefined || username === undefined) return []
    const auth = (['pageant', 'agent', 'key', 'password'] as const).find((a) => a === v['auth']) ?? 'pageant'
    const port = typeof v['port'] === 'number' && Number.isInteger(v['port']) ? v['port'] : 22
    const machine: Machine = { id: record.id, label, host, port, username, auth }
    const keyFile = text(v['keyFile'])
    const jumpVia = text(v['jumpVia'])
    const notes = text(v['notes'])
    const password = secret(record.id, 'password')
    const passphrase = secret(record.id, 'passphrase')
    if (keyFile !== undefined) machine.keyFile = keyFile
    if (jumpVia !== undefined) machine.jumpVia = jumpVia
    if (notes !== undefined) machine.notes = notes
    if (password !== undefined) machine.password = password
    if (passphrase !== undefined) machine.passphrase = passphrase
    return [machine]
  })
  const number = (value: unknown, fallback: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback
  return {
    machines,
    extraCommands: (text(values['extraCommands']) ?? '')
      .split(/[\r\n,]+/)
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z0-9._+-]+$/.test(name)),
    timeoutSeconds: number(values['timeoutSeconds'], 60, 1800),
    maxDownloadMB: number(values['maxDownloadMB'], 100, 4096),
    dataDir,
    downloadsDir: env['LIGHT_CODE_ADDON_DOWNLOADS'] ?? path.join(dataDir, 'downloads'),
  }
}

/** A machine by label, ignoring case; the error lists the labels there are. */
export function findMachine(settings: LinuxSettings, label: string): Machine {
  const found = settings.machines.find((machine) => machine.label.toLowerCase() === label.trim().toLowerCase())
  if (found !== undefined) return found
  const known = settings.machines.map((machine) => machine.label)
  throw new Error(
    known.length === 0
      ? 'No Linux machines are set up. Ask the user to add them on the Linux tab in Light Code settings.'
      : `No machine labelled "${label}". The machines are: ${known.join(', ')}.`,
  )
}
