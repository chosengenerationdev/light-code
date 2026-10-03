import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The encrypted secrets file Sun Code keeps, shared with its Rust side (`native/src/vault.rs`).
 *
 * AES-256-GCM over the JSON map of secrets, in a small JSON envelope. The key never touches disk in
 * the clear: Sun keeps it protected by Windows (DPAPI, per user - the protection VS Code's own
 * secret storage has) and hands it to each codebase's host on stdin, never in an environment
 * variable, where every command the agent runs would inherit it.
 *
 * Change the format in both places or neither; `vault.test.ts` and the Rust tests pin a shared
 * example.
 */

export interface VaultEnvelope {
  sunVault: 1
  iv: string
  tag: string
  data: string
}

export function isVaultEnvelope(value: unknown): value is VaultEnvelope {
  const v = value as Partial<VaultEnvelope> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    v.sunVault === 1 &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.data === 'string'
  )
}

export function sealSecrets(secrets: Record<string, string>, key: Buffer): VaultEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
  return { sunVault: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

/** Throws when the key is wrong or the file was altered: GCM authenticates as well as hides. */
export function openSecrets(envelope: VaultEnvelope, key: Buffer): Record<string, string> {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
  const parsed: unknown = JSON.parse(plain.toString('utf8'))
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
}

/** The key as Sun sends it: 64 hex characters on one line. */
export function parseVaultKey(line: string): Buffer | undefined {
  const hex = line.trim()
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : undefined
}
