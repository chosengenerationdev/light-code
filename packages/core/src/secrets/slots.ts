import { pythonEnvSecretRef } from '../python/env.js'

/** A place in secret storage a config refers to, and the words to show a person for it. */
export interface SecretSlot {
  key: string
  label: string
}

/** How a reference field is said to a person. */
const FIELD_WORDS: Record<string, string> = {
  apiKeyRef: 'API key',
  clientSecretRef: 'client secret',
  passphraseRef: 'key passphrase',
  passwordRef: 'password',
  usernameRef: 'username',
  tokenRef: 'token',
  secretAccessKeyRef: 'secret access key',
  sessionTokenRef: 'session token',
  valueRef: 'header value',
}

/** Section names, for a reference with no labelled object above it (`jira.tokenRef`). */
const SECTION_WORDS: Record<string, string> = {
  confluence: 'Confluence',
  jira: 'Jira',
  bitbucket: 'Bitbucket',
  jenkins: 'Jenkins',
  autosys: 'AutoSys',
  tls: 'Global client key',
  vectorStores: 'Search connection',
  s3: 'S3',
}

/**
 * Every secret-storage key a config points at, labelled for a person.
 *
 * Used to hand a config's secrets from one store to another (the VS Code extension sharing its keys
 * with Sun Light Code). Found by walking for `*Ref` fields rather than listing them, unlike the
 * export summary in `config/share.ts`: there a wrong *name* misleads somebody, here a missed *key*
 * is a credential silently left behind - so a field added later must be picked up without anyone
 * remembering to add it. Plus the two places a key is not a `*Ref`: Python variables marked secret
 * and `${secret:NAME}` in MCP server settings.
 *
 * Keys only; never values. `env:NAME` references are not secret storage and are skipped.
 */
export function secretSlots(config: unknown): SecretSlot[] {
  const found = new Map<string, string>()
  const add = (key: string, label: string): void => {
    if (key.length > 0 && !key.startsWith('env:') && !found.has(key)) found.set(key, label)
  }

  const walk = (value: unknown, path: string[], owner: string | undefined): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, path, owner))
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const named =
      typeof record.label === 'string' && record.label.length > 0
        ? record.label
        : typeof record.name === 'string' && record.name.length > 0
          ? record.name
          : undefined
    const here = named ?? owner
    for (const [field, child] of Object.entries(record)) {
      if (typeof child === 'string' && /Ref$/.test(field)) {
        const section = path.map((part) => SECTION_WORDS[part]).find((word) => word !== undefined)
        const who = here ?? section ?? path.at(-1) ?? 'Setting'
        add(child, `${who}: ${FIELD_WORDS[field] ?? field.replace(/Ref$/, '')}`)
      } else if (path.length === 0 && field === 'mcpServers') {
        walkMcp(child)
      } else if (path.length === 0 && field === 'python') {
        walkPython(child)
        walk(child, [...path, field], here)
      } else {
        walk(child, [...path, field], here)
      }
    }
  }

  const walkMcp = (servers: unknown): void => {
    if (servers === null || typeof servers !== 'object') return
    for (const [server, entry] of Object.entries(servers as Record<string, unknown>)) {
      for (const match of JSON.stringify(entry).matchAll(/\$\{secret:([^}]+)\}/g)) {
        add(match[1] as string, `MCP server ${server}: ${match[1] as string}`)
      }
    }
  }

  const walkPython = (python: unknown): void => {
    const env = (python as { env?: unknown } | null)?.env
    if (env === null || typeof env !== 'object') return
    for (const [name, entry] of Object.entries(env as Record<string, unknown>)) {
      if (typeof entry === 'object' && entry !== null && (entry as { secret?: unknown }).secret === true) {
        add(pythonEnvSecretRef(name), `Python variable ${name}`)
      }
    }
  }

  walk(config, [], undefined)
  return [...found].map(([key, label]) => ({ key, label }))
}
