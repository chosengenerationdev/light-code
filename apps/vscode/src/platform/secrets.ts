import * as vscode from 'vscode'
import type { SecretStore } from '@light-code/core'

/** Namespaces every key so `clear()` (or a deleted profile) can't leak orphans. */
const KEY_PREFIX = 'lightCode:'

function describeBackend(): string {
  switch (process.platform) {
    case 'win32':
      return 'VS Code SecretStorage (Windows Credential Manager / DPAPI)'
    case 'darwin':
      return 'VS Code SecretStorage (macOS Keychain)'
    case 'linux':
      return 'VS Code SecretStorage (libsecret, or an encrypted file fallback if unavailable)'
    default:
      return 'VS Code SecretStorage'
  }
}

/**
 * A registry of namespaced keys is kept alongside the secrets themselves so `clear()`
 * can enumerate and delete everything this store holds — `SecretStorage` has no
 * built-in "list all keys" operation.
 */
const REGISTRY_KEY = `${KEY_PREFIX}__registry`

export class VSCodeSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(KEY_PREFIX + key)
  }

  async set(key: string, value: string): Promise<void> {
    await this.secrets.store(KEY_PREFIX + key, value)
    const registry = await this.readRegistry()
    if (!registry.includes(key)) {
      registry.push(key)
      await this.writeRegistry(registry)
    }
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(KEY_PREFIX + key)
    const registry = await this.readRegistry()
    await this.writeRegistry(registry.filter((entry) => entry !== key))
  }

  async clear(): Promise<void> {
    const registry = await this.readRegistry()
    await Promise.all(registry.map((key) => this.secrets.delete(KEY_PREFIX + key)))
    await this.secrets.delete(REGISTRY_KEY)
  }

  backendName(): string {
    return describeBackend()
  }

  private async readRegistry(): Promise<string[]> {
    const raw = await this.secrets.get(REGISTRY_KEY)
    if (raw === undefined) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
    } catch {
      return []
    }
  }

  private async writeRegistry(keys: string[]): Promise<void> {
    await this.secrets.store(REGISTRY_KEY, JSON.stringify(keys))
  }
}
